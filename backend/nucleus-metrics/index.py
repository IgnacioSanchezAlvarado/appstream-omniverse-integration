import json
import os
import boto3
import urllib.request
import time
from datetime import datetime, timedelta, timezone

cloudwatch = boto3.client('cloudwatch', region_name=os.environ.get('REGION', 'eu-central-1'))
ec2 = boto3.client('ec2', region_name=os.environ.get('REGION', 'eu-central-1'))
ssm = boto3.client('ssm', region_name=os.environ.get('REGION', 'eu-central-1'))

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,X-Api-Key,Authorization',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Content-Type': 'application/json',
}

METRIC_QUERIES = {
    'NucleusApiLatency': {
        'namespace': 'AppStreamOmniverse/Nucleus',
        'metric_name': 'NucleusApiLatency',
        'dimensions_template': [{'Name': 'InstanceId', 'Value': '{instance_id}'}],
        'unit': 'Milliseconds',
    },
    'NucleusCpuUtilization': {
        'namespace': 'AppStreamOmniverse/Nucleus',
        'metric_name': 'cpu_usage_idle',
        'dimensions_template': [
            {'Name': 'InstanceId', 'Value': '{instance_id}'},
            {'Name': 'cpu', 'Value': 'cpu-total'},
        ],
        'unit': 'Percent',
        'transform': 'cpu_idle_to_utilization',
    },
    'NucleusMemoryUtilization': {
        'namespace': 'AppStreamOmniverse/Nucleus',
        'metric_name': 'mem_used_percent',
        'dimensions_template': [{'Name': 'InstanceId', 'Value': '{instance_id}'}],
        'unit': 'Percent',
    },
    'NucleusDiskUsage': {
        'namespace': 'AppStreamOmniverse/Nucleus',
        'metric_name': 'disk_used_percent',
        'dimensions_template': [
            {'Name': 'InstanceId', 'Value': '{instance_id}'},
            {'Name': 'path', 'Value': '/'},
        ],
        'unit': 'Percent',
    },
    'NucleusNetworkIn': {
        'namespace': 'AppStreamOmniverse/Nucleus',
        'metric_name': 'net_bytes_recv',
        'dimensions_template': [{'Name': 'InstanceId', 'Value': '{instance_id}'}],
        'unit': 'Bytes',
    },
    'NucleusNetworkOut': {
        'namespace': 'AppStreamOmniverse/Nucleus',
        'metric_name': 'net_bytes_sent',
        'dimensions_template': [{'Name': 'InstanceId', 'Value': '{instance_id}'}],
        'unit': 'Bytes',
    },
}


def query_nucleus_metrics(instance_id, start_time, end_time, period):
    """Query CloudWatch for Nucleus metrics."""
    metrics = {}
    summary = {}

    for friendly_name, query_config in METRIC_QUERIES.items():
        try:
            dimensions = [
                {'Name': dim['Name'], 'Value': dim['Value'].format(instance_id=instance_id)}
                for dim in query_config['dimensions_template']
            ]

            result = cloudwatch.get_metric_statistics(
                Namespace=query_config['namespace'],
                MetricName=query_config['metric_name'],
                Dimensions=dimensions,
                StartTime=start_time,
                EndTime=end_time,
                Period=period,
                Statistics=['Average', 'Minimum', 'Maximum'],
            )

            transform_type = query_config.get('transform')

            datapoints = []
            for dp in result['Datapoints']:
                if transform_type == 'cpu_idle_to_utilization':
                    # For idle → utilization: 100 - idle
                    # Min utilization = 100 - Max idle
                    # Max utilization = 100 - Min idle
                    datapoints.append({
                        'timestamp': dp['Timestamp'].isoformat(),
                        'average': round(100 - dp['Average'], 2),
                        'minimum': round(100 - dp['Maximum'], 2),  # Note: inverted
                        'maximum': round(100 - dp['Minimum'], 2),  # Note: inverted
                    })
                else:
                    datapoints.append({
                        'timestamp': dp['Timestamp'].isoformat(),
                        'average': round(dp['Average'], 2),
                        'minimum': round(dp['Minimum'], 2),
                        'maximum': round(dp['Maximum'], 2),
                    })

            datapoints = sorted(datapoints, key=lambda x: x['timestamp'])

            metrics[friendly_name] = {'datapoints': datapoints, 'unit': query_config['unit']}

            if datapoints:
                latest = datapoints[-1]
                averages = [dp['average'] for dp in datapoints]
                minimums = [dp['minimum'] for dp in datapoints]
                maximums = [dp['maximum'] for dp in datapoints]
                summary[friendly_name] = {
                    'current': round(latest['average'], 2),
                    'average': round(sum(averages) / len(averages), 2),
                    'minimum': round(min(minimums), 2),
                    'maximum': round(max(maximums), 2),
                    'unit': query_config['unit'],
                }
            else:
                summary[friendly_name] = {
                    'current': 0,
                    'average': 0,
                    'minimum': 0,
                    'maximum': 0,
                    'unit': query_config['unit'],
                }

        except Exception as e:
            # If metric query fails, return empty data
            metrics[friendly_name] = {'datapoints': [], 'unit': query_config['unit']}
            summary[friendly_name] = {
                'current': 0,
                'average': 0,
                'minimum': 0,
                'maximum': 0,
                'unit': query_config['unit'],
            }

    return metrics, summary


def handle_status(event):
    """Handle GET /nucleus/status - return instance state and connection info."""
    try:
        instance_id = os.environ.get('NUCLEUS_INSTANCE_ID')
        if not instance_id:
            return response(500, {'error': 'NUCLEUS_INSTANCE_ID not configured'})

        # Get instance state from EC2
        ec2_result = ec2.describe_instances(InstanceIds=[instance_id])

        if not ec2_result['Reservations']:
            return response(404, {'error': 'Instance not found'})

        instance = ec2_result['Reservations'][0]['Instances'][0]
        state = instance['State']['Name']
        private_ip = instance.get('PrivateIpAddress', os.environ.get('NUCLEUS_PRIVATE_IP', 'unknown'))
        launch_time = instance.get('LaunchTime')

        # Check SSM agent status
        ssm_online = False
        try:
            ssm_result = ssm.describe_instance_information(
                Filters=[{'Key': 'InstanceIds', 'Values': [instance_id]}]
            )
            if ssm_result['InstanceInformationList']:
                ssm_status = ssm_result['InstanceInformationList'][0]['PingStatus']
                ssm_online = (ssm_status == 'Online')
        except Exception:
            # SSM check failed, assume offline
            pass

        return response(200, {
            'status': state,
            'instanceId': instance_id,
            'privateIp': private_ip,
            'connectionString': f'omniverse://{private_ip}',
            'launchTime': launch_time.isoformat() if launch_time else None,
            'ssmOnline': ssm_online,
            'webUiUrl': f'http://{private_ip}:8080',
        })

    except Exception as e:
        print(f'Error: {e}')  # Log server-side
        return response(500, {'error': 'Internal server error'})


def handle_metrics(event):
    """Handle GET /nucleus/metrics - return time-series CloudWatch metrics."""
    try:
        params = event.get('queryStringParameters') or {}

        instance_id = os.environ.get('NUCLEUS_INSTANCE_ID')
        if not instance_id:
            return response(500, {'error': 'NUCLEUS_INSTANCE_ID not configured'})

        now = datetime.now(timezone.utc)
        start_time = parse_time(params.get('startTime'), now - timedelta(hours=1))
        end_time = parse_time(params.get('endTime'), now)
        period = int(params.get('period', '60'))
        if not (60 <= period <= 86400):
            return response(400, {'error': 'period must be between 60 and 86400 seconds'})

        metrics, summary = query_nucleus_metrics(instance_id, start_time, end_time, period)

        return response(200, {
            'metrics': metrics,
            'summary': summary,
            'query': {
                'instanceId': instance_id,
                'startTime': start_time.isoformat(),
                'endTime': end_time.isoformat(),
                'period': period,
            },
        })

    except Exception as e:
        print(f'Error: {e}')  # Log server-side
        return response(500, {'error': 'Internal server error'})


def handle_eventbridge(event):
    """Invoked by EventBridge every 1 minute to probe Nucleus and publish metrics."""
    nucleus_ip = os.environ.get('NUCLEUS_PRIVATE_IP')
    instance_id = os.environ.get('NUCLEUS_INSTANCE_ID', 'unknown')

    if not nucleus_ip:
        return {'statusCode': 500, 'body': json.dumps({'error': 'NUCLEUS_PRIVATE_IP not configured'})}

    # Probe Nucleus web UI
    try:
        start = time.time()
        req = urllib.request.Request(f'http://{nucleus_ip}:8080/', method='GET')
        req.add_header('User-Agent', 'NucleusMetricsProbe/1.0')
        urllib.request.urlopen(req, timeout=10)
        latency_ms = (time.time() - start) * 1000
    except Exception:
        latency_ms = -1  # -1 indicates unreachable

    if latency_ms >= 0:
        cloudwatch.put_metric_data(
            Namespace='AppStreamOmniverse/Nucleus',
            MetricData=[{
                'MetricName': 'NucleusApiLatency',
                'Value': latency_ms,
                'Unit': 'Milliseconds',
                'Dimensions': [
                    {'Name': 'InstanceId', 'Value': instance_id}
                ]
            }]
        )

    return {'statusCode': 200, 'body': json.dumps({'latency_ms': latency_ms})}


def handler(event, context):
    # EventBridge invocation (scheduled probe)
    if event.get('source') == 'aws.events' or event.get('detail-type'):
        return handle_eventbridge(event)

    # API Gateway invocation
    path = event.get('path', '')
    if path.endswith('/status'):
        return handle_status(event)
    elif path.endswith('/metrics'):
        return handle_metrics(event)
    else:
        return response(404, {'error': 'Not found'})


def parse_time(value, default):
    if not value:
        return default
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def response(status_code, body):
    return {
        'statusCode': status_code,
        'headers': CORS_HEADERS,
        'body': json.dumps(body),
    }
