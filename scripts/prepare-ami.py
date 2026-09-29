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
    python scripts/prepare-ami.py --marketplace-ami ami-XXXXXXXXXXXXXXXXX
    python scripts/prepare-ami.py --testing  # Keep instance running for manual testing
    python scripts/prepare-ami.py --from-instance i-abc123  # Resume from existing instance
"""

import argparse
import base64
import gzip
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
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)
    return {}


def discover_infrastructure(ec2, project_name):
    """Find VPC, private/public subnets, and security group created by CDK."""
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
        return None, [], [], None

    vpc_id = vpcs[0]['VpcId']
    log(f'Found VPC: {vpc_id}')

    # Find private subnets
    private_subnets = ec2.describe_subnets(Filters=[
        {'Name': 'vpc-id', 'Values': [vpc_id]},
        {'Name': 'tag:aws-cdk:subnet-type', 'Values': ['Private']},
    ]).get('Subnets', [])

    if not private_subnets:
        private_subnets = ec2.describe_subnets(Filters=[
            {'Name': 'vpc-id', 'Values': [vpc_id]},
            {'Name': 'tag:Name', 'Values': ['*Private*']},
        ]).get('Subnets', [])

    private_subnet_ids = [s['SubnetId'] for s in private_subnets]
    log(f'Found {len(private_subnet_ids)} private subnets: {", ".join(private_subnet_ids)}')

    # Find public subnets
    public_subnets = ec2.describe_subnets(Filters=[
        {'Name': 'vpc-id', 'Values': [vpc_id]},
        {'Name': 'tag:aws-cdk:subnet-type', 'Values': ['Public']},
    ]).get('Subnets', [])

    if not public_subnets:
        public_subnets = ec2.describe_subnets(Filters=[
            {'Name': 'vpc-id', 'Values': [vpc_id]},
            {'Name': 'tag:Name', 'Values': ['*Public*']},
        ]).get('Subnets', [])

    public_subnet_ids = [s['SubnetId'] for s in public_subnets]
    log(f'Found {len(public_subnet_ids)} public subnets: {", ".join(public_subnet_ids)}')

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

    return vpc_id, private_subnet_ids, public_subnet_ids, sg_id


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
    time.sleep(10)  # nosemgrep: arbitrary-sleep - IAM propagation delay required
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


def import_to_appstream(appstream, cfn, sts, ami_id, ami_name, project_name, region, config, skip_runtime_validation=False):
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
    base_image_name = f'omniverse-g6e-{timestamp}'

    if skip_runtime_validation:
        log('Skipping runtime validation (--skip-runtime-validation flag set)')
        return _do_import(appstream, base_image_name, ami_id, role_arn, region, appstream_tags, None)

    # Build list of validation instance types to try (ordered by size for cost efficiency)
    validation_types = [
        'Accelerated.g6e.xlarge',
        'Accelerated.g6e.2xlarge',
        'Accelerated.g6e.4xlarge',
        'Accelerated.g6e.8xlarge',
    ]

    # Pre-check quotas to skip types with quota=0
    sq = boto3.client('service-quotas', region_name=region)
    valid_types = []
    for vtype in validation_types:
        try:
            paginator = sq.get_paginator('list_service_quotas')
            for page in paginator.paginate(ServiceCode='appstream2'):
                for quota in page['Quotas']:
                    if vtype in quota['QuotaName'] and 'image builders' in quota['QuotaName']:
                        if quota['Value'] > 0:
                            valid_types.append(vtype)
                            log(f'  {vtype}: quota={int(quota["Value"])} (eligible)')
                        else:
                            log(f'  {vtype}: quota=0 (skipping)')
                        break
                else:
                    continue
                break
        except Exception as e:
            log(f'  {vtype}: quota check failed ({e}), will try anyway')
            valid_types.append(vtype)

    if not valid_types:
        log('WARNING: All validation instance types have quota=0. Trying anyway with g6e.xlarge...')
        valid_types = ['Accelerated.g6e.xlarge']

    log(f'Validation instance types to try: {valid_types}')

    # Try each validation type
    for i, vtype in enumerate(valid_types):
        # Use unique name per attempt so failed images don't block retries
        image_name = base_image_name if i == 0 else f'{base_image_name}-v{i+1}'
        log(f'Attempting import with validation type: {vtype} (image: {image_name})')

        result = _do_import(appstream, image_name, ami_id, role_arn, region, appstream_tags, vtype)
        if result is not None:
            return result

        # If we get here, this attempt failed — try next type
        if i < len(valid_types) - 1:
            log(f'Trying next validation instance type...')

    log('ERROR: All validation instance types failed.')
    return None


def _do_import(appstream, image_name, ami_id, role_arn, region, appstream_tags, validation_type):
    """Attempt a single AppStream image import. Returns image_name on success, None on failure."""
    log(f'Creating AppStream image: {image_name}')

    cmd = [
        'aws', 'appstream', 'create-imported-image',
        '--name', image_name,
        '--source-ami-id', ami_id,
        '--iam-role-arn', role_arn,
        '--agent-software-version', 'ALWAYS_LATEST',
        '--description', f'AppStream image from {ami_id}',
        '--display-name', 'Omniverse Developer Kit',
        '--region', region,
    ]
    if validation_type:
        cmd.extend(['--runtime-validation-config', json.dumps({'IntendedInstanceType': validation_type})])
    if appstream_tags:
        cmd.extend(['--tags', json.dumps(appstream_tags)])

    # nosemgrep: dangerous-subprocess-use-audit - cmd values from trusted config and AWS API responses only
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        stderr = result.stderr
        if 'LimitExceededException' in stderr:
            log(f'  Quota exceeded for {validation_type}, skipping.')
            return None
        log(f'ERROR: Failed to create AppStream imported image: {stderr}')
        return None
    log(f'AppStream image import started: {image_name}')

    # Poll for image availability
    log('Waiting for AppStream image to become available (max 60 minutes)...')
    max_attempts = 120  # 120 * 30s = 60 minutes
    for attempt in range(max_attempts):
        try:
            resp = appstream.describe_images(Names=[image_name])
            if not resp.get('Images'):
                log(f'  Image not found yet, retrying... ({attempt * 30}s elapsed)')
                time.sleep(30)  # nosemgrep: arbitrary-sleep - polling AppStream image status
                continue

            image = resp['Images'][0]
            state = image['State']

            if state == 'AVAILABLE':
                log(f'AppStream image is AVAILABLE: {image_name}')
                return image_name
            elif state == 'FAILED':
                reason = image.get('StateChangeReason', {}).get('Message', 'Unknown')
                errors = image.get('ImageErrors', [])
                log(f'AppStream image import FAILED: {reason}')
                for error in errors:
                    log(f'  Error Code: {error.get("ErrorCode")}, Message: {error.get("ErrorMessage")}')
                # Clean up failed image
                try:
                    appstream.delete_image(Name=image_name)
                    log(f'  Cleaned up failed image: {image_name}')
                except Exception:
                    pass
                return None
            else:
                if attempt % 4 == 0:  # Log every 2 minutes
                    log(f'  State: {state} ({attempt * 30}s elapsed)')
        except ClientError as e:
            log(f'  Error checking image status: {e}')

        if attempt < max_attempts - 1:
            time.sleep(30)  # nosemgrep: arbitrary-sleep - polling AppStream image status

    log(f'Timeout waiting for AppStream image (60 minutes). Import is still in progress.')
    return f'TIMEOUT:{image_name}'


def update_config_with_image(image_name, project_name):
    """Update config.json with new AppStream image name."""
    try:
        with open(CONFIG_PATH, 'r', encoding="utf-8") as f:
            config = json.load(f)

        if 'image' not in config:
            config['image'] = {}

        config['image']['customImageName'] = image_name

        with open(CONFIG_PATH, 'w', encoding="utf-8") as f:
            json.dump(config, f, indent=2)

        log(f'Updated config.json: image.customImageName = {image_name}')
        return True
    except Exception as e:
        log(f'ERROR: Failed to update config.json: {e}')
        return False


def discover_default_vpc_subnets(ec2):
    """Find default VPC and its subnets as last resort."""
    try:
        vpcs = ec2.describe_vpcs(Filters=[{'Name': 'isDefault', 'Values': ['true']}]).get('Vpcs', [])
        if not vpcs:
            return []

        vpc_id = vpcs[0]['VpcId']
        subnets = ec2.describe_subnets(Filters=[{'Name': 'vpc-id', 'Values': [vpc_id]}]).get('Subnets', [])
        subnet_ids = [s['SubnetId'] for s in subnets]
        log(f'Found default VPC: {vpc_id} with {len(subnet_ids)} subnets')
        return subnet_ids
    except Exception as e:
        log(f'Could not find default VPC: {e}')
        return []


def launch_instance(ec2, ami_id, private_subnets, public_subnets, sg_id, project_name, profile_name, instance_types=None, grid_driver_s3_path='s3://ec2-windows-nvidia-drivers/latest/'):
    """Try instance types across subnets until one succeeds.

    Tries in order:
    1. Private subnets from CDK VPC (with SG)
    2. Public subnets from CDK VPC (with public IP)
    3. Default VPC subnets (as last resort, with public IP)
    """
    global _instance_id
    with open(USERDATA_FILE, 'r', encoding='utf-8') as f:
        userdata_text = f.read()

    # Replace GRID driver S3 path with config value
    userdata_text = userdata_text.replace(
        's3://ec2-windows-nvidia-drivers/latest/',
        grid_driver_s3_path
    )
    userdata_raw = userdata_text.encode('utf-8')
    userdata_b64 = base64.b64encode(gzip.compress(userdata_raw)).decode()

    types_to_try = instance_types or DEFAULT_INSTANCE_TYPES

    # Build list of (subnet_id, needs_public_ip, sg_id_to_use, label) tuples
    subnet_attempts = []

    # Phase 1: Private subnets from CDK VPC (preferred)
    for subnet_id in private_subnets:
        subnet_attempts.append((subnet_id, False, sg_id, 'private'))

    # Phase 2: Public subnets from CDK VPC
    for subnet_id in public_subnets:
        subnet_attempts.append((subnet_id, True, sg_id, 'public'))

    # Phase 3: Default VPC subnets (discover once, add as last resort)
    default_subnets = discover_default_vpc_subnets(ec2)
    if default_subnets:
        # Get default security group for default VPC
        try:
            subnet_info = ec2.describe_subnets(SubnetIds=[default_subnets[0]])['Subnets'][0]
            default_vpc_id = subnet_info['VpcId']
            default_sgs = ec2.describe_security_groups(Filters=[
                {'Name': 'vpc-id', 'Values': [default_vpc_id]},
                {'Name': 'group-name', 'Values': ['default']},
            ]).get('SecurityGroups', [])
            default_sg = default_sgs[0]['GroupId'] if default_sgs else None
            for subnet_id in default_subnets:
                subnet_attempts.append((subnet_id, True, default_sg, 'default-vpc'))
        except Exception as e:
            log(f'Could not set up default VPC fallback: {e}')

    log(f'Will try {len(subnet_attempts)} subnets across {len(types_to_try)} instance types')

    for instance_type in types_to_try:
        for subnet_id, needs_public_ip, security_group, subnet_type in subnet_attempts:
            try:
                log(f'Trying {instance_type} in {subnet_type} subnet {subnet_id}...')

                base_params = {
                    'ImageId': ami_id,
                    'InstanceType': instance_type,
                    'MinCount': 1,
                    'MaxCount': 1,
                    'IamInstanceProfile': {'Name': profile_name},
                    'UserData': userdata_b64,
                    'BlockDeviceMappings': [{
                        'DeviceName': '/dev/sda1',
                        'Ebs': {'VolumeSize': 200, 'VolumeType': 'gp3', 'Encrypted': False},
                    }],
                    'TagSpecifications': [{
                        'ResourceType': 'instance',
                        'Tags': [
                            {'Key': 'Name', 'Value': f'{project_name}-ami-prep'},
                            {'Key': 'Project', 'Value': project_name},
                        ],
                    }],
                }

                # For public subnets, use NetworkInterfaces to set public IP
                if needs_public_ip:
                    base_params['NetworkInterfaces'] = [{
                        'DeviceIndex': 0,
                        'SubnetId': subnet_id,
                        'AssociatePublicIpAddress': True,
                        'Groups': [security_group] if security_group else [],
                        'DeleteOnTermination': True,
                    }]
                else:
                    # Private subnet: use SubnetId + SecurityGroupIds
                    base_params['SubnetId'] = subnet_id
                    if security_group:
                        base_params['SecurityGroupIds'] = [security_group]

                resp = ec2.run_instances(**base_params)
                instance_id = resp['Instances'][0]['InstanceId']
                _instance_id = instance_id
                log(f'Launched {instance_id} ({instance_type}) in {subnet_type} subnet')
                return instance_id, instance_type
            except ClientError as e:
                code = e.response['Error']['Code']
                msg = e.response['Error'].get('Message', '')
                if code in ('InsufficientInstanceCapacity', 'Unsupported',
                            'UnsupportedOperation') or 'capacity' in msg.lower():
                    log(f'  {code}: {msg}, trying next...')
                    continue
                raise

    print(f'\nERROR: Could not launch any instance type across all available subnets.')
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
    parser.add_argument('--skip-runtime-validation', action='store_true',
                        help='Skip AppStream runtime validation during import (use if g6e validation is failing)')
    args = parser.parse_args()

    signal.signal(signal.SIGINT, handle_interrupt)

    if args.skip_runtime_validation:
        log('Runtime validation will be skipped for AppStream import')

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
            elif config.get('image', {}).get('baseAmiId'):
                base_ami = config['image']['baseAmiId']
                try:
                    resp = ec2.describe_images(ImageIds=[base_ami])
                    if not resp['Images']:
                        raise ValueError('AMI not found')
                    log(f'Using pinned base AMI from config: {base_ami}')
                except Exception:
                    log(f'WARNING: Pinned AMI {base_ami} not found in {args.region} — falling back to SSM lookup')
                    base_ami = get_base_ami(ssm, args.region, ami_param)
                    log(f'Resolved AMI for {args.region}: {base_ami}')
                    log(f'TIP: Pin this AMI in config.json → image.baseAmiId: "{base_ami}"')
            else:
                base_ami = get_base_ami(ssm, args.region, ami_param)
                log('WARNING: Using latest AMI from SSM. Pin image.baseAmiId in config.json to avoid breakage.')

            # Step 2: Discover infrastructure
            log('--- Step 2/8: Discovering infrastructure ---')
            private_subnets = [args.subnet_id] if args.subnet_id else []
            public_subnets = []
            sg_id = args.security_group_id
            if not private_subnets or not sg_id:
                _, disc_private, disc_public, disc_sg = discover_infrastructure(ec2, args.project_name)
                private_subnets = private_subnets or disc_private
                public_subnets = disc_public
                sg_id = sg_id or disc_sg

            if not private_subnets and not public_subnets:
                log('WARNING: No CDK subnets found. Will try default VPC as fallback.')
                # Don't exit - we can still try default VPC

            # Step 3: Create IAM instance profile
            log('--- Step 3/8: Creating IAM instance profile ---')
            profile_name = create_instance_profile(iam, args.project_name)

            # Step 4: Launch GPU instance (tries types from config in order)
            ami_builder_types = config.get('amiBuilder', {}).get('instanceTypes', None)
            grid_driver_s3_path = config.get('amiBuilder', {}).get('gridDriverS3Path', 's3://ec2-windows-nvidia-drivers/latest/')
            log(f'--- Step 4/8: Launching GPU instance (preference: {ami_builder_types or DEFAULT_INSTANCE_TYPES}) ---')
            inst_id, inst_type = launch_instance(ec2, base_ami, private_subnets, public_subnets, sg_id, args.project_name, profile_name, ami_builder_types, grid_driver_s3_path)

            # Step 5: Wait for setup and ensure userdata executes
            log('--- Step 5/8: Waiting for instance + GRID driver install ---')
            waiter = ec2.get_waiter('instance_status_ok')
            waiter.wait(InstanceIds=[inst_id], WaiterConfig={'Delay': 30, 'MaxAttempts': 40})
            log('Status checks passed.')

            # Wait for SSM to come online
            log('Waiting for SSM agent to become available...')
            time.sleep(90)  # nosemgrep: arbitrary-sleep - wait for SSM agent to initialize after instance start
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
                    time.sleep(15)  # nosemgrep: arbitrary-sleep - polling SSM agent status
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
                time.sleep(5)  # nosemgrep: arbitrary-sleep - wait for SSM command to register
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
                with open(USERDATA_FILE, encoding="utf-8") as f:
                    userdata_content = f.read()

                # Replace GRID driver S3 path with config value
                userdata_content = userdata_content.replace(
                    's3://ec2-windows-nvidia-drivers/latest/',
                    grid_driver_s3_path
                )

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
                                time.sleep(5)  # nosemgrep: arbitrary-sleep - wait for SSM command to register
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
                        time.sleep(30)  # nosemgrep: arbitrary-sleep - polling SSM command status
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
        timeout_image_name = None
        if not args.skip_appstream_import and not args.testing:
            appstream_image_name = import_to_appstream(
                appstream, cfn, sts, ami_id, ami_name, args.project_name, args.region, config, args.skip_runtime_validation
            )

            if appstream_image_name and appstream_image_name.startswith('TIMEOUT:'):
                timeout_image_name = appstream_image_name.split(':', 1)[1]
                appstream_image_name = None

            if appstream_image_name:
                # Update config.json
                if update_config_with_image(appstream_image_name, args.project_name):
                    log('Config updated successfully.')
            elif timeout_image_name:
                log(f'AppStream image import is still in progress: {timeout_image_name}')
                log('The import exceeded the wait time but may still succeed.')
            else:
                log('WARNING: AppStream image import failed.')
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
        elif timeout_image_name:
            print(f'  AppStream:  {timeout_image_name} (STILL IN PROGRESS)')
        print('=' * 60)

        if appstream_image_name:
            # Success path - AppStream import completed
            print('\nNext steps:')
            print(f'  1. Deploy the fleet with new image: cd infra && cdk deploy')
            print(f'  2. Start the fleet and test streaming session')
            print(f'  3. Verify Omniverse and GPU drivers: nvidia-smi')
        elif timeout_image_name:
            # Timeout - import still in progress on AWS side
            print('\n' + '-' * 60)
            print('  APPSTREAM IMAGE IMPORT STILL IN PROGRESS')
            print('  The import exceeded the script wait time but is still')
            print('  running on AWS. It may still succeed.')
            print('-' * 60)
            print(f'\nCheck status:')
            print(f'  aws appstream describe-images \\')
            print(f'    --names {timeout_image_name} \\')
            print(f'    --region {args.region} \\')
            print(f'    --query "Images[0].State" --output text')
            print(f'\nOnce the image shows AVAILABLE:')
            print(f'  1. Update config.json: set image.customImageName = "{timeout_image_name}"')
            print(f'  2. Deploy the fleet: cd infra && cdk deploy')
            print(f'  3. Start the fleet and test streaming session')
        elif args.skip_appstream_import:
            # Intentional skip - user chose not to import
            print('\nNext steps:')
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
            print('  4. Update config.json: image.customImageName = "<image-name>"')
            print('  5. Run: cd infra && cdk deploy')
        else:
            # FAILED import - make it loud and exit with error
            print('\n' + '!' * 60)
            print('  APPSTREAM IMAGE IMPORT FAILED')
            print('  The AMI was created but could not be imported to AppStream.')
            print('  config.json was NOT updated. The fleet will NOT be created')
            print('  until you complete the import manually.')
            print('!' * 60)
            print('\nManual recovery steps:')
            print(f'  1. Import AMI to AppStream via CLI:')
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
            print('  4. Update config.json: image.customImageName = "<image-name>"')
            print('  5. Run: cd infra && cdk deploy')
            sys.exit(1)

    finally:
        if args.testing:
            log('Testing mode — keeping IAM role for SSM access.')
        else:
            cleanup_iam(iam, args.project_name)


if __name__ == '__main__':
    main()
