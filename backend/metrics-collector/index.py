import json
import os
import boto3
from datetime import datetime, timedelta, timezone

cloudwatch = boto3.client('cloudwatch', region_name=os.environ.get('REGION', 'eu-central-1'))

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,X-Api-Key,Authorization',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Content-Type': 'application/json',
}

METRICS = {
    'InSessionLatency': 'Milliseconds',
    'FramesPerSecond': 'Count',
    'Bandwidth': 'Kilobits/Second',
    'CpuUtilizationInstance': 'Percent',
}


def query_cloudwatch_metrics(dimensions, start_time, end_time, period):
    """Query CloudWatch for all AppStream metrics with given dimensions."""
    metrics = {}
    summary = {}

    for metric_name, unit in METRICS.items():
        result = cloudwatch.get_metric_statistics(
            Namespace='AWS/AppStream',
            MetricName=metric_name,
            Dimensions=dimensions,
            StartTime=start_time,
            EndTime=end_time,
            Period=period,
            Statistics=['Average', 'Minimum', 'Maximum'],
        )

        datapoints = sorted(
            [
                {
                    'timestamp': dp['Timestamp'].isoformat(),
                    'average': round(dp['Average'], 2),
                    'minimum': round(dp['Minimum'], 2),
                    'maximum': round(dp['Maximum'], 2),
                }
                for dp in result['Datapoints']
            ],
            key=lambda x: x['timestamp'],
        )

        metrics[metric_name] = {'datapoints': datapoints, 'unit': unit}

        if datapoints:
            latest = datapoints[-1]
            averages = [dp['average'] for dp in datapoints]
            minimums = [dp['minimum'] for dp in datapoints]
            maximums = [dp['maximum'] for dp in datapoints]
            summary[metric_name] = {
                'current': round(latest['average'], 2),
                'average': round(sum(averages) / len(averages), 2),
                'minimum': round(min(minimums), 2),
                'maximum': round(max(maximums), 2),
                'unit': unit,
            }
        else:
            summary[metric_name] = {
                'current': 0,
                'average': 0,
                'minimum': 0,
                'maximum': 0,
                'unit': unit,
            }

    return metrics, summary


def handler(event, context):
    try:
        params = event.get('queryStringParameters') or {}

        fleet = params.get('fleet') or os.environ.get('FLEET_NAME')
        if not fleet:
            return response(400, {'error': 'Missing required parameter: fleet'})

        now = datetime.now(timezone.utc)
        start_time = parse_time(params.get('startTime'), now - timedelta(hours=1))
        end_time = parse_time(params.get('endTime'), now)
        period = int(params.get('period', '60'))

        dimensions = [{'Name': 'Fleet', 'Value': fleet}]
        if params.get('instanceId'):
            dimensions.append({'Name': 'InstanceId', 'Value': params['instanceId']})
        if params.get('sessionId'):
            dimensions.append({'Name': 'SessionId', 'Value': params['sessionId']})
        if params.get('userId'):
            dimensions.append({'Name': 'UserId', 'Value': params['userId']})

        has_session_filter = len(dimensions) > 1

        metrics, summary = query_cloudwatch_metrics(dimensions, start_time, end_time, period)

        # Fallback: if session-level query returned no data, retry at fleet level
        if has_session_filter and all(len(m['datapoints']) == 0 for m in metrics.values()):
            fleet_dimensions = [{'Name': 'Fleet', 'Value': fleet}]
            metrics, summary = query_cloudwatch_metrics(fleet_dimensions, start_time, end_time, period)

        return response(200, {
            'metrics': metrics,
            'summary': summary,
            'query': {
                'fleet': fleet,
                'startTime': start_time.isoformat(),
                'endTime': end_time.isoformat(),
                'period': period,
            },
        })

    except Exception as e:
        return response(500, {'error': str(e)})


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
