#!/usr/bin/env python3
"""Build an AppStream-compatible AMI for G6e (Accelerated.g6e) instances.

Starts from the NVIDIA Omniverse Developer Kit marketplace AMI (which includes
pre-installed Omniverse and NVIDIA drivers) and adds AppStream prerequisites.
Can fall back to a TPM-enabled Windows Server 2022 base AMI if marketplace AMI
is not configured. The resulting AMI can be imported into AppStream for use
with G6e instance types (L40S GPUs).

Usage:
    python scripts/prepare-ami.py
    python scripts/prepare-ami.py --region eu-central-1
    python scripts/prepare-ami.py --marketplace-ami ami-07bafd3ee37eb865e
    python scripts/prepare-ami.py --testing  # Keep instance running for manual testing
    python scripts/prepare-ami.py --from-instance i-abc123  # Resume from existing instance
"""

import argparse
import base64
import json
import os
import signal
import subprocess
import sys
import time

import boto3
from botocore.exceptions import ClientError

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, '..', 'config.json')

DEFAULT_INSTANCE_TYPES = [
    'g6e.2xlarge', 'g6e.xlarge', 'g6e.4xlarge',
]

USERDATA_FILE = os.path.join(SCRIPT_DIR, 'userdata.ps1')

ROLE_POLICY = json.dumps({
    "Version": "2012-10-17",
    "Statement": [{"Effect": "Allow", "Principal": {"Service": "ec2.amazonaws.com"}, "Action": "sts:AssumeRole"}]
})

# Globals for cleanup on interrupt
_instance_id = None
_ec2 = None
_iam_role = None
_iam_profile = None


def log(msg):
    print(f'[{time.strftime("%H:%M:%S")}] {msg}')


def load_config():
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH) as f:
            return json.load(f)
    return {}


def discover_infrastructure(ec2, project_name):
    """Find VPC, private subnets, and security group created by CDK."""
    log(f'Auto-discovering infrastructure (Project tag: {project_name})...')

    # Find VPC by project tag
    vpcs = ec2.describe_vpcs(Filters=[
        {'Name': 'tag:aws-cdk:cr-owned:appstream-omniverse', 'Values': ['*']},
    ]).get('Vpcs', [])

    if not vpcs:
        # Fallback: find VPC by Name tag pattern
        vpcs = ec2.describe_vpcs(Filters=[
            {'Name': 'tag:Name', 'Values': [f'*{project_name}*', '*AppStreamOmniverse*']},
        ]).get('Vpcs', [])

    if not vpcs:
        return None, [], None

    vpc_id = vpcs[0]['VpcId']
    log(f'Found VPC: {vpc_id}')

    subnets = ec2.describe_subnets(Filters=[
        {'Name': 'vpc-id', 'Values': [vpc_id]},
        {'Name': 'tag:aws-cdk:subnet-type', 'Values': ['Private']},
    ]).get('Subnets', [])

    if not subnets:
        subnets = ec2.describe_subnets(Filters=[
            {'Name': 'vpc-id', 'Values': [vpc_id]},
            {'Name': 'tag:Name', 'Values': ['*Private*']},
        ]).get('Subnets', [])

    subnet_ids = [s['SubnetId'] for s in subnets]
    log(f'Found {len(subnet_ids)} private subnets: {", ".join(subnet_ids)}')

    # Find security group
    sgs = ec2.describe_security_groups(Filters=[
        {'Name': 'vpc-id', 'Values': [vpc_id]},
        {'Name': 'tag:Name', 'Values': ['*FleetSg*', f'*{project_name}*']},
    ]).get('SecurityGroups', [])

    if not sgs:
        sgs = ec2.describe_security_groups(Filters=[
            {'Name': 'vpc-id', 'Values': [vpc_id]},
            {'Name': 'description', 'Values': ['*AppStream*', '*fleet*']},
        ]).get('SecurityGroups', [])

    sg_id = sgs[0]['GroupId'] if sgs else None
    if sg_id:
        log(f'Found security group: {sg_id}')

    return vpc_id, subnet_ids, sg_id


def get_base_ami(ssm, region, param_name):
    """Look up the TPM-enabled Windows Server 2022 AMI via SSM parameter."""
    resp = ssm.get_parameter(Name=param_name)
    ami_id = resp['Parameter']['Value']
    log(f'Base AMI from SSM: {ami_id}')
    return ami_id


def create_instance_profile(iam, project_name):
    """Create temporary IAM role + instance profile for S3 access (GRID driver download)."""
    global _iam_role, _iam_profile
    role_name = f'{project_name}-ami-prep-role'
    profile_name = f'{project_name}-ami-prep-profile'
    _iam_role = role_name
    _iam_profile = profile_name

    try:
        iam.create_role(RoleName=role_name, AssumeRolePolicyDocument=ROLE_POLICY, Description='Temporary role for AMI prep')
    except iam.exceptions.EntityAlreadyExistsException:
        log(f'IAM role {role_name} already exists, reusing.')

    try:
        iam.attach_role_policy(RoleName=role_name, PolicyArn='arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess')
    except Exception:
        pass

    try:
        iam.attach_role_policy(RoleName=role_name, PolicyArn='arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore')
    except Exception:
        pass

    try:
        iam.create_instance_profile(InstanceProfileName=profile_name)
    except iam.exceptions.EntityAlreadyExistsException:
        log(f'Instance profile {profile_name} already exists, reusing.')

    try:
        iam.add_role_to_instance_profile(InstanceProfileName=profile_name, RoleName=role_name)
    except iam.exceptions.LimitExceededException:
        pass

    log(f'IAM profile ready: {profile_name} (waiting 10s for propagation)')
    time.sleep(10)
    return profile_name


def cleanup_iam(iam, project_name):
    """Remove temporary IAM role + instance profile."""
    role_name = f'{project_name}-ami-prep-role'
    profile_name = f'{project_name}-ami-prep-profile'
    try:
        iam.remove_role_from_instance_profile(InstanceProfileName=profile_name, RoleName=role_name)
    except Exception:
        pass
    try:
        iam.delete_instance_profile(InstanceProfileName=profile_name)
    except Exception:
        pass
    try:
        iam.detach_role_policy(RoleName=role_name, PolicyArn='arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess')
    except Exception:
        pass
    try:
        iam.detach_role_policy(RoleName=role_name, PolicyArn='arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore')
    except Exception:
        pass
    try:
        iam.delete_role(RoleName=role_name)
    except Exception:
        pass
    log('IAM cleanup done.')


def get_image_import_role_arn(cfn, sts, project_name, region):
    """Get image import role ARN from CDK stack output or construct it."""
    try:
        # Try to get from CloudFormation stack outputs
        resp = cfn.describe_stacks(StackName='AppStreamOmniverseStack')
        outputs = resp['Stacks'][0].get('Outputs', [])
        for output in outputs:
            if output['OutputKey'] == 'ImageImportRoleArn':
                log(f'Found ImageImportRoleArn from CDK stack: {output["OutputValue"]}')
                return output['OutputValue']
    except Exception as e:
        log(f'Could not get ImageImportRoleArn from stack (stack may not exist): {e}')

    # Fallback: construct ARN
    account_id = sts.get_caller_identity()['Account']
    role_arn = f'arn:aws:iam::{account_id}:role/{project_name}-image-import-role'
    log(f'Using fallback ImageImportRoleArn: {role_arn}')
    return role_arn


def import_to_appstream(appstream, cfn, sts, ami_id, ami_name, project_name, region, config):
    """Import AMI to AppStream as a custom image."""
    log('--- Step 7/8: Importing AMI to AppStream ---')

    # Get tags from config
    tags = config.get('tags', {})
    appstream_tags = {k: str(v) for k, v in tags.items()} if tags else {}

    # Get image import role ARN
    role_arn = get_image_import_role_arn(cfn, sts, project_name, region)

    # Generate AppStream image name (timestamp-based, same as AMI)
    # Note: AppStream image names cannot start with 'appstream', 'aws', 'amazon'
    timestamp = ami_name.split('-')[-1]  # Extract timestamp from ami_name
    image_name = f'omniverse-g6e-{timestamp}'

    log(f'Creating AppStream image: {image_name}')

    # Build AWS CLI command (boto3 doesn't support create_imported_image in version 1.35.49)
    cmd = [
        'aws', 'appstream', 'create-imported-image',
        '--name', image_name,
        '--source-ami-id', ami_id,
        '--iam-role-arn', role_arn,
        '--runtime-validation-config', json.dumps({'IntendedInstanceType': 'Accelerated.g6e.xlarge'}),
        '--agent-software-version', 'ALWAYS_LATEST',
        '--description', f'AppStream image from {ami_id}',
        '--display-name', 'Omniverse Developer Kit',
        '--region', region,
    ]
    # Add tags if present
    if appstream_tags:
        cmd.extend(['--tags', json.dumps(appstream_tags)])

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        log(f'ERROR: Failed to create AppStream imported image: {result.stderr}')
        return None
    log(f'AppStream image import started: {image_name}')

    # Poll for image availability
    log('Waiting for AppStream image to become available (max 45 minutes)...')
    max_attempts = 90  # 90 * 30s = 45 minutes
    for attempt in range(max_attempts):
        try:
            resp = appstream.describe_images(Names=[image_name])
            if not resp.get('Images'):
                log(f'  Image not found yet, retrying... ({attempt * 30}s elapsed)')
                time.sleep(30)
                continue

            image = resp['Images'][0]
            state = image['State']

            if state == 'AVAILABLE':
                log(f'AppStream image is AVAILABLE: {image_name}')
                return image_name
            elif state == 'FAILED':
                errors = image.get('ImageErrors', [])
                log(f'ERROR: AppStream image import FAILED.')
                for error in errors:
                    log(f'  Error Code: {error.get("ErrorCode")}, Message: {error.get("ErrorMessage")}')
                return None
            else:
                if attempt % 4 == 0:  # Log every 2 minutes
                    log(f'  State: {state} ({attempt * 30}s elapsed)')
        except ClientError as e:
            log(f'  Error checking image status: {e}')

        if attempt < max_attempts - 1:
            time.sleep(30)

    log('ERROR: Timeout waiting for AppStream image (45 minutes)')
    return None


def update_config_with_image(image_name, project_name):
    """Update config.json with new AppStream image name."""
    try:
        with open(CONFIG_PATH, 'r') as f:
            config = json.load(f)

        if 'image' not in config:
            config['image'] = {}

        config['image']['customImageName'] = image_name

        with open(CONFIG_PATH, 'w') as f:
            json.dump(config, f, indent=2)

        log(f'Updated config.json: image.customImageName = {image_name}')
        return True
    except Exception as e:
        log(f'ERROR: Failed to update config.json: {e}')
        return False


def launch_instance(ec2, ami_id, subnet_ids, sg_id, project_name, profile_name, instance_types=None):
    """Try instance types across subnets until one succeeds."""
    global _instance_id
    with open(USERDATA_FILE) as f:
        userdata_b64 = base64.b64encode(f.read().encode()).decode()

    types_to_try = instance_types or DEFAULT_INSTANCE_TYPES
    for instance_type in types_to_try:
        for subnet_id in subnet_ids:
            try:
                log(f'Trying {instance_type} in subnet {subnet_id}...')
                resp = ec2.run_instances(
                    ImageId=ami_id,
                    InstanceType=instance_type,
                    MinCount=1, MaxCount=1,
                    SubnetId=subnet_id,
                    SecurityGroupIds=[sg_id],
                    IamInstanceProfile={'Name': profile_name},
                    UserData=userdata_b64,
                    BlockDeviceMappings=[{
                        'DeviceName': '/dev/sda1',
                        'Ebs': {'VolumeSize': 200, 'VolumeType': 'gp3', 'Encrypted': False},
                    }],
                    TagSpecifications=[{
                        'ResourceType': 'instance',
                        'Tags': [
                            {'Key': 'Name', 'Value': f'{project_name}-ami-prep'},
                            {'Key': 'Project', 'Value': project_name},
                        ],
                    }],
                )
                instance_id = resp['Instances'][0]['InstanceId']
                _instance_id = instance_id
                log(f'Launched {instance_id} ({instance_type})')
                return instance_id, instance_type
            except ClientError as e:
                code = e.response['Error']['Code']
                msg = e.response['Error'].get('Message', '')
                if code in ('InsufficientInstanceCapacity', 'Unsupported',
                            'UnsupportedOperation') or 'capacity' in msg.lower():
                    log(f'  {code}: {msg}, trying next...')
                    continue
                raise

    print(f'\nERROR: Could not launch any instance type.')
    sys.exit(1)


def handle_interrupt(signum, frame):
    """Handle Ctrl+C — offer to terminate EC2 instance."""
    global _instance_id, _ec2
    print('\n')
    if _instance_id and _ec2:
        resp = input(f'Terminate instance {_instance_id}? [Y/n] ').strip().lower()
        if resp in ('', 'y', 'yes'):
            log(f'Terminating {_instance_id}...')
            _ec2.terminate_instances(InstanceIds=[_instance_id])
            log('Instance terminated.')
        else:
            log(f'Instance {_instance_id} left running. Remember to terminate it manually.')
    sys.exit(1)


def main():
    global _ec2

    config = load_config()
    region = config.get('region', 'eu-central-1')
    project = config.get('projectName', 'appstream-omniverse')
    ami_param = config.get('image', {}).get('baseAmiParameter',
        '/aws/service/ami-windows-latest/TPM-Windows_Server-2022-English-Full-Base')
    marketplace_ami = config.get('image', {}).get('marketplaceAmiId', '')

    parser = argparse.ArgumentParser(description='Build AppStream G6e AMI')
    parser.add_argument('--region', default=region)
    parser.add_argument('--project-name', default=project)
    parser.add_argument('--subnet-id', help='Override auto-discovery')
    parser.add_argument('--security-group-id', help='Override auto-discovery')
    parser.add_argument('--marketplace-ami', help='Override marketplace AMI ID from config')
    parser.add_argument('--testing', action='store_true', help='Keep instance running for manual testing')
    parser.add_argument('--from-instance', help='Resume AMI creation from existing instance ID')
    parser.add_argument('--skip-appstream-import', action='store_true', help='Skip automatic AppStream image import')
    args = parser.parse_args()

    signal.signal(signal.SIGINT, handle_interrupt)

    ec2 = boto3.client('ec2', region_name=args.region)
    iam = boto3.client('iam', region_name=args.region)
    ssm = boto3.client('ssm', region_name=args.region)
    appstream = boto3.client('appstream', region_name=args.region)
    cfn = boto3.client('cloudformation', region_name=args.region)
    sts = boto3.client('sts', region_name=args.region)
    _ec2 = ec2

    try:
        # Handle --from-instance: skip steps 1-5, go straight to AMI creation
        if args.from_instance:
            inst_id = args.from_instance
            _instance_id = inst_id
            log(f'Resuming from existing instance: {inst_id}')
            inst_type = 'unknown'
            inst_info = ec2.describe_instances(InstanceIds=[inst_id])['Reservations'][0]['Instances'][0]
            inst_type = inst_info.get('InstanceType', 'unknown')
            log(f'Instance type: {inst_type}')
        else:
            # Step 1: Resolve base AMI
            log('--- Step 1/8: Resolving base AMI ---')

            # Use plain Windows Server 2022 AMI by default (no marketplace product codes).
            # Marketplace AMIs carry product codes that block AppStream image import.
            # Use --marketplace-ami only if you need pre-installed Omniverse software
            # and will NOT import to AppStream.
            if args.marketplace_ami:
                base_ami = args.marketplace_ami
                log(f'Using marketplace AMI from CLI: {base_ami}')
                log('WARNING: Marketplace AMIs carry product codes that may block AppStream import.')
            else:
                base_ami = get_base_ami(ssm, args.region, ami_param)

            # Step 2: Discover infrastructure
            log('--- Step 2/8: Discovering infrastructure ---')
            subnet_ids = [args.subnet_id] if args.subnet_id else []
            sg_id = args.security_group_id
            if not subnet_ids or not sg_id:
                _, disc_sub, disc_sg = discover_infrastructure(ec2, args.project_name)
                subnet_ids = subnet_ids or disc_sub
                sg_id = sg_id or disc_sg
            if not subnet_ids or not sg_id:
                print('ERROR: No subnets/SG found. Deploy CDK first.')
                sys.exit(1)

            # Step 3: Create IAM instance profile
            log('--- Step 3/8: Creating IAM instance profile ---')
            profile_name = create_instance_profile(iam, args.project_name)

            # Step 4: Launch GPU instance (tries types from config in order)
            ami_builder_types = config.get('amiBuilder', {}).get('instanceTypes', None)
            log(f'--- Step 4/8: Launching GPU instance (preference: {ami_builder_types or DEFAULT_INSTANCE_TYPES}) ---')
            inst_id, inst_type = launch_instance(ec2, base_ami, subnet_ids, sg_id, args.project_name, profile_name, ami_builder_types)

            # Step 5: Wait for setup and ensure userdata executes
            log('--- Step 5/8: Waiting for instance + GRID driver install ---')
            waiter = ec2.get_waiter('instance_status_ok')
            waiter.wait(InstanceIds=[inst_id], WaiterConfig={'Delay': 30, 'MaxAttempts': 40})
            log('Status checks passed.')

            # Wait for SSM to come online
            log('Waiting for SSM agent to become available...')
            time.sleep(90)
            for attempt in range(20):
                try:
                    resp = ssm.describe_instance_information(
                        Filters=[{'Key': 'InstanceIds', 'Values': [inst_id]}]
                    )
                    if resp.get('InstanceInformationList') and \
                       resp['InstanceInformationList'][0].get('PingStatus') == 'Online':
                        log('SSM agent is online.')
                        break
                except Exception as e:
                    log(f'SSM not ready yet: {e}')
                if attempt < 19:
                    time.sleep(15)
            else:
                log('WARNING: SSM agent did not come online, proceeding anyway...')

            # Check if userdata already completed
            log('Checking if userdata executed automatically...')
            completion_marker_exists = False
            try:
                check_resp = ssm.send_command(
                    InstanceIds=[inst_id],
                    DocumentName='AWS-RunPowerShellScript',
                    Parameters={'commands': ['Test-Path C:\\PrepAMI.complete']},
                    TimeoutSeconds=60
                )
                check_cmd_id = check_resp['Command']['CommandId']
                time.sleep(5)
                result = ssm.get_command_invocation(
                    CommandId=check_cmd_id,
                    InstanceId=inst_id
                )
                if result['Status'] == 'Success' and 'True' in result.get('StandardOutputContent', ''):
                    completion_marker_exists = True
                    log('Userdata already completed (C:\\PrepAMI.complete exists).')
            except Exception as e:
                log(f'Could not check completion marker: {e}')

            # If userdata didn't execute, run it via SSM
            if not completion_marker_exists:
                log('Userdata did not auto-execute, running via SSM...')

                # Read and encode userdata.ps1 (strip <powershell> tags)
                with open(USERDATA_FILE) as f:
                    userdata_content = f.read()

                # Remove XML tags
                userdata_content = userdata_content.replace('<powershell>', '').replace('</powershell>', '').strip()

                # Base64 encode
                userdata_b64 = base64.b64encode(userdata_content.encode()).decode()

                # Send SSM command to decode and execute
                log('Sending userdata script via SSM...')
                ssm_resp = ssm.send_command(
                    InstanceIds=[inst_id],
                    DocumentName='AWS-RunPowerShellScript',
                    Parameters={'commands': [
                        f"[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('{userdata_b64}')) | Out-File C:\\PrepAMI.ps1 -Encoding UTF8",
                        "& C:\\PrepAMI.ps1"
                    ]},
                    TimeoutSeconds=3600,
                )
                ssm_cmd_id = ssm_resp['Command']['CommandId']
                log(f'SSM command ID: {ssm_cmd_id}')

                # Poll SSM command status
                log('Waiting for userdata script to complete (max 30 min)...')
                for attempt in range(60):
                    try:
                        inv = ssm.get_command_invocation(
                            CommandId=ssm_cmd_id,
                            InstanceId=inst_id
                        )
                        status = inv['Status']
                        if status in ('Success', 'Failed', 'Cancelled', 'TimedOut'):
                            if status == 'Success':
                                log(f'Userdata script completed successfully.')
                                # Verify completion marker
                                verify_resp = ssm.send_command(
                                    InstanceIds=[inst_id],
                                    DocumentName='AWS-RunPowerShellScript',
                                    Parameters={'commands': ['Test-Path C:\\PrepAMI.complete']},
                                    TimeoutSeconds=60
                                )
                                time.sleep(5)
                                verify_result = ssm.get_command_invocation(
                                    CommandId=verify_resp['Command']['CommandId'],
                                    InstanceId=inst_id
                                )
                                if 'True' in verify_result.get('StandardOutputContent', ''):
                                    log('Completion marker verified.')
                                else:
                                    log('WARNING: Script succeeded but completion marker not found.')
                                break
                            else:
                                log(f'ERROR: Userdata script failed with status: {status}')
                                log(f'Error output: {inv.get("StandardErrorContent", "N/A")}')
                                raise Exception(f'Userdata script failed: {status}')
                        else:
                            if attempt % 4 == 0:  # Log every 2 minutes
                                log(f'  Status: {status} ({attempt * 30}s elapsed)')
                    except ssm.exceptions.InvocationDoesNotExist:
                        if attempt % 4 == 0:
                            log(f'  Waiting for command to be registered ({attempt * 30}s elapsed)')

                    if attempt < 59:
                        time.sleep(30)
                else:
                    log('ERROR: SSM command timed out after 30 minutes.')
                    raise Exception('Userdata script execution timed out')
            else:
                log('Userdata already completed, skipping SSM fallback.')

            # Exit early if --testing flag is set
            if args.testing:
                print('\n' + '=' * 60)
                print(f'  TESTING MODE - Instance ready for manual verification')
                print(f'  Instance ID:   {inst_id}')
                print(f'  Instance Type:  {inst_type}')
                print('=' * 60)
                print(f'\nConnect via Fleet Manager RDP (no public IP or key pair needed):')
                print(f'  https://{args.region}.console.aws.amazon.com/systems-manager/fleet-manager/{inst_id}/connect?region={args.region}')
                print(f'\nCheck setup log:  C:\\PrepAMI.log')
                print(f'Verify drivers:   nvidia-smi')
                print(f'\nWhen done testing:')
                print(f'  1. Resume AMI creation: python scripts/prepare-ami.py --from-instance {inst_id}')
                print(f'  2. Or terminate manually: aws ec2 terminate-instances --instance-ids {inst_id} --region {args.region}')
                return

        # Step 6: Stop instance and create AMI
        log('--- Step 6/8: Stopping instance + creating AMI ---')
        ec2.stop_instances(InstanceIds=[inst_id])
        ec2.get_waiter('instance_stopped').wait(InstanceIds=[inst_id])
        log('Instance stopped.')

        ami_name = f'{args.project_name}-g6e-{int(time.time())}'

        # Get root volume
        vols = ec2.describe_instances(InstanceIds=[inst_id])['Reservations'][0]['Instances'][0]['BlockDeviceMappings']
        root_vol = next(v['Ebs']['VolumeId'] for v in vols if v['DeviceName'] == '/dev/sda1')
        log(f'Root volume: {root_vol}')

        # Create snapshot
        snap = ec2.create_snapshot(
            VolumeId=root_vol,
            Description=f'Snapshot for {ami_name}',
            TagSpecifications=[{'ResourceType': 'snapshot', 'Tags': [
                {'Key': 'Name', 'Value': ami_name},
                {'Key': 'Project', 'Value': args.project_name},
            ]}]
        )
        snap_id = snap['SnapshotId']
        log(f'Snapshot started: {snap_id}')
        ec2.get_waiter('snapshot_completed').wait(SnapshotIds=[snap_id], WaiterConfig={'Delay': 30, 'MaxAttempts': 120})
        log(f'Snapshot {snap_id} complete.')

        # Register AMI with TPM v2.0
        resp = ec2.register_image(
            Name=ami_name,
            Description=f'AppStream G6e with GRID driver ({inst_type})',
            Architecture='x86_64',
            RootDeviceName='/dev/sda1',
            BootMode='uefi',
            TpmSupport='v2.0',
            EnaSupport=True,
            VirtualizationType='hvm',
            BlockDeviceMappings=[{
                'DeviceName': '/dev/sda1',
                'Ebs': {
                    'SnapshotId': snap_id,
                    'VolumeSize': 200,
                    'VolumeType': 'gp3',
                    'DeleteOnTermination': True
                },
            }],
            TagSpecifications=[{'ResourceType': 'image', 'Tags': [
                {'Key': 'Name', 'Value': ami_name},
                {'Key': 'Project', 'Value': args.project_name},
                {'Key': 'Purpose', 'Value': 'appstream-g6e-import'},
            ]}],
        )
        ami_id = resp['ImageId']
        log(f'AMI registered: {ami_id}')
        ec2.get_waiter('image_available').wait(ImageIds=[ami_id], WaiterConfig={'Delay': 30, 'MaxAttempts': 120})
        log(f'AMI {ami_id} available.')

        # Verify properties
        img = ec2.describe_images(ImageIds=[ami_id])['Images'][0]
        log(f'  BootMode={img.get("BootMode")}, TpmSupport={img.get("TpmSupport")}, '
            f'Encrypted={img["BlockDeviceMappings"][0]["Ebs"].get("Encrypted")}')

        # Step 7: Import to AppStream (unless --skip-appstream-import or --testing)
        appstream_image_name = None
        if not args.skip_appstream_import and not args.testing:
            appstream_image_name = import_to_appstream(
                appstream, cfn, sts, ami_id, ami_name, args.project_name, args.region, config
            )

            if appstream_image_name:
                # Update config.json
                if update_config_with_image(appstream_image_name, args.project_name):
                    log('Config updated successfully.')
            else:
                log('WARNING: AppStream image import failed or timed out.')
                log('You can manually import the AMI using the instructions below.')

        # Step 8: Cleanup
        log('--- Step 8/8: Cleanup ---')
        ec2.terminate_instances(InstanceIds=[inst_id])
        log(f'Instance {inst_id} terminated.')

        print('\n' + '=' * 60)
        print(f'  AMI READY:  {ami_id}')
        print(f'  Name:       {ami_name}')
        print(f'  Instance:   {inst_type}')
        print(f'  BootMode:   {img.get("BootMode")}')
        print(f'  TPM:        {img.get("TpmSupport")}')
        if appstream_image_name:
            print(f'  AppStream:  {appstream_image_name} (AVAILABLE)')
        print('=' * 60)

        if appstream_image_name:
            print('\nNext steps:')
            print(f'  1. Deploy the fleet with new image: cd infra && cdk deploy')
            print(f'  2. Start the fleet and test streaming session')
            print(f'  3. Verify Omniverse and GPU drivers: nvidia-smi')
        else:
            print('\nNext steps:')
            if args.skip_appstream_import:
                print('  (AppStream import skipped with --skip-appstream-import flag)')
            print('  1. Import AMI to AppStream via CLI:')
            print(f'     aws appstream create-imported-image \\')
            print(f'       --name {args.project_name}-<timestamp> \\')
            print(f'       --source-image-id {ami_id} \\')
            print(f'       --iam-role-arn <image-import-role-arn> \\')
            print(f'       --runtime-validation-config IntendedInstanceType=Accelerated.g6e.xlarge \\')
            print(f'       --agent-software-version ALWAYS_LATEST \\')
            print(f'       --region {args.region}')
            print('  2. Or use AppStream console > Images > Import Image')
            print(f'     AMI ID: {ami_id}')
            print(f'     Instance type: Accelerated.g6e.xlarge')
            print(f'     IAM role: {args.project_name}-image-import-role')
            print('  3. Wait for image Available (~30 min)')
            print('  4. Update config.json: image.customImageName')
            print('  5. Run: cd infra && cdk deploy')

    finally:
        if args.testing:
            log('Testing mode — keeping IAM role for SSM access.')
        else:
            cleanup_iam(iam, args.project_name)


if __name__ == '__main__':
    main()
