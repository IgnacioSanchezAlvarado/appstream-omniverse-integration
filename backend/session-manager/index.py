import json
import os
import boto3

appstream = boto3.client('appstream', region_name=os.environ.get('REGION', 'eu-central-1'))

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,X-Api-Key,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Type': 'application/json',
}


def handler(event, context):
    try:
        method = event.get('httpMethod', 'GET')

        if method == 'GET':
            return list_sessions(event)
        elif method == 'POST':
            return create_streaming_url(event)
        else:
            return response(405, {'error': f'Method {method} not allowed'})

    except Exception as e:
        return response(500, {'error': str(e)})


def list_sessions(event):
    params = event.get('queryStringParameters') or {}
    stack_name = params.get('stackName') or os.environ.get('STACK_NAME')
    fleet_name = params.get('fleetName') or os.environ.get('FLEET_NAME')

    if not stack_name or not fleet_name:
        return response(400, {'error': 'Missing required parameters: stackName, fleetName'})

    result = appstream.describe_sessions(
        StackName=stack_name,
        FleetName=fleet_name,
    )

    sessions = [
        {
            'sessionId': s['Id'],
            'userId': s['UserId'],
            'state': s['State'],
            'startTime': s['StartTime'].isoformat() if 'StartTime' in s else None,
            'instanceId': s.get('InstanceId', ''),
        }
        for s in result.get('Sessions', [])
    ]

    return response(200, {
        'sessions': sessions,
        'stackName': stack_name,
        'fleetName': fleet_name,
    })


def create_streaming_url(event):
    body = json.loads(event.get('body') or '{}')
    stack_name = body.get('stackName') or os.environ.get('STACK_NAME')
    fleet_name = body.get('fleetName') or os.environ.get('FLEET_NAME')
    user_id = body.get('userId')
    validity = int(body.get('validity', 60))

    if not stack_name or not fleet_name or not user_id:
        return response(400, {'error': 'Missing required parameters: stackName, fleetName, userId'})

    result = appstream.create_streaming_url(
        StackName=stack_name,
        FleetName=fleet_name,
        UserId=user_id,
        Validity=validity,
    )

    return response(200, {
        'streamingUrl': result['StreamingURL'],
        'expires': result['Expires'].isoformat(),
    })


def response(status_code, body):
    return {
        'statusCode': status_code,
        'headers': CORS_HEADERS,
        'body': json.dumps(body),
    }
