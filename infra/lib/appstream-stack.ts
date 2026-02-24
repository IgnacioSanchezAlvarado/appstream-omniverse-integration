import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as appstream from 'aws-cdk-lib/aws-appstream';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as path from 'path';
import * as config from '../../config.json';

// Phase 1: Set customImageName = "" → deploys VPC, API, dashboard, image import role
// Phase 2: Set customImageName = "your-image" → adds fleet, stack, association

const fleetEnabled = config.image.customImageName !== '';
const dashboardEnabled = config.monitoring.dashboardEnabled;
const nucleusEnabled = (config as any).nucleus?.enabled ?? false;
const nucleusMetricsEnabled = nucleusEnabled && ((config as any).nucleus?.metricsEnabled ?? false);

export class AppStreamOmniverseStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const fleetName = `${config.projectName}-fleet`;
    const stackName = `${config.projectName}-stack`;

    // ──────────────────────────────────────────────
    // VPC: 2 AZs, public + private subnets, 1 NAT GW
    // ──────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 3,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // Security group for AppStream fleet instances
    const fleetSg = new ec2.SecurityGroup(this, 'FleetSg', {
      vpc,
      description: 'Security group for AppStream fleet instances',
      allowAllOutbound: true,
    });

    // ──────────────────────────────────────────────
    // IAM Role: AppStream image import
    // ──────────────────────────────────────────────
    const imageImportRole = new iam.Role(this, 'ImageImportRole', {
      roleName: `${config.projectName}-image-import-role`,
      assumedBy: new iam.ServicePrincipal('appstream.amazonaws.com'),
    });

    imageImportRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:ModifyImageAttribute',
        'ec2:DescribeImages',
      ],
      resources: ['*'],
    }));

    // ──────────────────────────────────────────────
    // AppStream: Fleet + Stack (Phase 2 only)
    // ──────────────────────────────────────────────
    if (fleetEnabled) {
      // IAM Role for Fleet Instances
      const fleetRole = new iam.Role(this, 'FleetInstanceRole', {
        assumedBy: new iam.ServicePrincipal('appstream.amazonaws.com'),
        description: 'IAM role for AppStream fleet instances to access SSM parameters',
      });

      fleetRole.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/${config.projectName}/nucleus/endpoint`,
        ],
      }));

      const fleet = new appstream.CfnFleet(this, 'Fleet', {
        name: fleetName,
        instanceType: config.fleet.instanceType,
        fleetType: config.fleet.fleetType,
        imageName: config.image.customImageName,
        iamRoleArn: fleetRole.roleArn,
        computeCapacity: {
          desiredInstances: config.fleet.minCapacity,
        },
        maxUserDurationInSeconds: 57600,
        disconnectTimeoutInSeconds: 900,
        idleDisconnectTimeoutInSeconds: 600,
        streamView: 'DESKTOP',
        vpcConfig: {
          subnetIds: vpc.privateSubnets.map(s => s.subnetId),
          securityGroupIds: [fleetSg.securityGroupId],
        },
        enableDefaultInternetAccess: false,
        tags: [
          { key: 'Project', value: config.tags.Project },
          { key: 'Environment', value: config.tags.Environment },
        ],
      });

      const appStreamStack = new appstream.CfnStack(this, 'AppStreamStack', {
        name: stackName,
        storageConnectors: [
          { connectorType: 'HOMEFOLDERS' },
        ],
        applicationSettings: {
          enabled: true,
          settingsGroup: config.projectName,
        },
        userSettings: [
          { action: 'CLIPBOARD_COPY_FROM_LOCAL_DEVICE', permission: 'ENABLED' },
          { action: 'CLIPBOARD_COPY_TO_LOCAL_DEVICE', permission: 'ENABLED' },
          { action: 'FILE_UPLOAD', permission: 'ENABLED' },
          { action: 'FILE_DOWNLOAD', permission: 'ENABLED' },
          { action: 'PRINTING_TO_LOCAL_DEVICE', permission: 'ENABLED' },
        ],
        tags: [
          { key: 'Project', value: config.tags.Project },
          { key: 'Environment', value: config.tags.Environment },
        ],
      });

      const association = new appstream.CfnStackFleetAssociation(this, 'StackFleetAssociation', {
        fleetName: fleet.name!,
        stackName: appStreamStack.name!,
      });
      association.addDependency(fleet);
      association.addDependency(appStreamStack);
    }

    // ──────────────────────────────────────────────
    // Lambda: Metrics Collector
    // ──────────────────────────────────────────────
    const metricsLambda = new lambda.Function(this, 'MetricsCollector', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/metrics-collector')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        FLEET_NAME: fleetName,
        REGION: config.region,
      },
    });

    metricsLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudwatch:GetMetricStatistics',
        'cloudwatch:GetMetricData',
      ],
      resources: ['*'],
    }));

    // ──────────────────────────────────────────────
    // Lambda: Session Manager
    // ──────────────────────────────────────────────
    const sessionLambda = new lambda.Function(this, 'SessionManager', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/session-manager')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        STACK_NAME: stackName,
        FLEET_NAME: fleetName,
        REGION: config.region,
      },
    });

    sessionLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'appstream:DescribeSessions',
        'appstream:CreateStreamingURL',
      ],
      resources: ['*'],
    }));

    // ──────────────────────────────────────────────
    // API Gateway: REST API with API Key auth
    // ──────────────────────────────────────────────
    const api = new apigateway.RestApi(this, 'Api', {
      restApiName: `${config.projectName}-api`,
      description: 'AppStream Omniverse metrics and session management API',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'X-Api-Key', 'Authorization'],
      },
      deployOptions: {
        stageName: 'prod',
      },
    });

    const apiKeyValue = `${config.projectName}-${this.account}-api-key`;
    const apiKey = api.addApiKey('ApiKey', {
      apiKeyName: `${config.projectName}-api-key`,
      value: apiKeyValue,
    });

    const usagePlan = api.addUsagePlan('UsagePlan', {
      name: `${config.projectName}-usage-plan`,
      throttle: {
        rateLimit: 50,
        burstLimit: 100,
      },
    });

    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({
      stage: api.deploymentStage,
    });

    const metricsResource = api.root.addResource('metrics');
    metricsResource.addMethod('GET', new apigateway.LambdaIntegration(metricsLambda), {
      apiKeyRequired: true,
    });

    const sessionsResource = api.root.addResource('sessions');
    sessionsResource.addMethod('GET', new apigateway.LambdaIntegration(sessionLambda), {
      apiKeyRequired: true,
    });
    sessionsResource.addMethod('POST', new apigateway.LambdaIntegration(sessionLambda), {
      apiKeyRequired: true,
    });

    // ──────────────────────────────────────────────
    // S3: Dashboard hosting bucket (conditional)
    // ──────────────────────────────────────────────
    if (dashboardEnabled) {
      const dashboardBucket = new s3.Bucket(this, 'DashboardBucket', {
        bucketName: `${config.projectName}-dashboard-${this.account}`,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        encryption: s3.BucketEncryption.S3_MANAGED,
      });

      // ──────────────────────────────────────────────
      // CloudFront: Distribution with OAC
      // ──────────────────────────────────────────────
      const distribution = new cloudfront.Distribution(this, 'Distribution', {
        defaultBehavior: {
          origin: origins.S3BucketOrigin.withOriginAccessControl(dashboardBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        },
        defaultRootObject: 'index.html',
        errorResponses: [
          {
            httpStatus: 403,
            responseHttpStatus: 200,
            responsePagePath: '/index.html',
          },
          {
            httpStatus: 404,
            responseHttpStatus: 200,
            responsePagePath: '/index.html',
          },
        ],
      });

      // ──────────────────────────────────────────────
      // S3 Deployment: Upload dashboard build + runtime config
      // ──────────────────────────────────────────────
      new s3deploy.BucketDeployment(this, 'DashboardDeployment', {
        sources: [
          s3deploy.Source.asset(path.join(__dirname, '../../web/metrics-dashboard/dist')),
          s3deploy.Source.jsonData('runtime-config.json', {
            apiUrl: api.url.replace(/\/+$/, ''),
            apiKey: apiKeyValue,
            nucleusEnabled: nucleusMetricsEnabled,
          }),
        ],
        destinationBucket: dashboardBucket,
        distribution,
        distributionPaths: ['/*'],
      });

      // ──────────────────────────────────────────────
      // Dashboard URL Output
      // ──────────────────────────────────────────────
      new cdk.CfnOutput(this, 'DashboardUrl', {
        value: `https://${distribution.distributionDomainName}`,
        description: 'Metrics dashboard URL',
      });
    }

    // ──────────────────────────────────────────────
    // Nucleus Server (conditional)
    // ──────────────────────────────────────────────
    if (nucleusEnabled) {
      const nucleusConfig = (config as any).nucleus;

      // Secrets Manager: Admin and service account credentials
      const adminSecret = new secretsmanager.Secret(this, 'NucleusAdminSecret', {
        secretName: `${config.projectName}/nucleus/admin`,
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ username: 'omniverse' }),
          generateStringKey: 'password',
          excludePunctuation: true,
          passwordLength: 32,
        },
      });

      const serviceSecret = new secretsmanager.Secret(this, 'NucleusServiceSecret', {
        secretName: `${config.projectName}/nucleus/service`,
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ username: 'omniverse-service' }),
          generateStringKey: 'password',
          excludePunctuation: true,
          passwordLength: 32,
        },
      });

      // Security Group for Nucleus EC2
      const nucleusSg = new ec2.SecurityGroup(this, 'NucleusSg', {
        vpc,
        description: 'Security group for Nucleus server',
        allowAllOutbound: true,
      });

      const nucleusPorts = [3009, 3020, 3030, 3100, 3180, 3333, 3400, 8080];
      for (const port of nucleusPorts) {
        nucleusSg.addIngressRule(
          fleetSg,
          ec2.Port.tcp(port),
          `AppStream fleet access on port ${port}`,
        );
      }

      // IAM Role for Nucleus EC2 instance
      const nucleusRole = new iam.Role(this, 'NucleusInstanceRole', {
        assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
          iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
        ],
      });

      adminSecret.grantRead(nucleusRole);
      serviceSecret.grantRead(nucleusRole);

      nucleusRole.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: ['*'],
      }));

      // EC2 Instance: Ubuntu 22.04 LTS
      const nucleusInstance = new ec2.Instance(this, 'NucleusInstance', {
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        instanceType: new ec2.InstanceType(nucleusConfig.instanceType),
        machineImage: ec2.MachineImage.fromSsmParameter(
          '/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id',
        ),
        securityGroup: nucleusSg,
        role: nucleusRole,
        blockDevices: [
          {
            deviceName: '/dev/sda1',
            volume: ec2.BlockDeviceVolume.ebs(nucleusConfig.storageSize, {
              volumeType: ec2.EbsDeviceVolumeType.GP3,
              encrypted: true,
            }),
          },
        ],
        ssmSessionPermissions: true,
        requireImdsv2: true,
      });

      // User data bootstrap script
      nucleusInstance.addUserData(
        '#!/bin/bash',
        'set -euxo pipefail',
        'exec > >(tee /var/log/nucleus-bootstrap.log) 2>&1',
        '',
        `GITHUB_REPO_URL="https://raw.githubusercontent.com/aws-samples/nvidia-omniverse-modular-solution-with-aws-cdk/main/packages/infra/src/nucleus/tools/nucleusServer/stack"`,
        `ADMIN_SECRET_ARN="${adminSecret.secretArn}"`,
        `SERVICE_SECRET_ARN="${serviceSecret.secretArn}"`,
        `REGION="${config.region}"`,
        `NUCLEUS_BUILD="${nucleusConfig.nucleusBuild}"`,
        `METRICS_ENABLED="${nucleusMetricsEnabled}"`,
        '',
        'echo "=== Nucleus Bootstrap Started at $(date) ==="',
        '',
        '# System setup',
        'apt-get update -y',
        'DEBIAN_FRONTEND=noninteractive apt-get install -y unzip curl awscli python3 python3-pip jq ca-certificates gnupg lsb-release',
        '',
        '# Install Docker',
        'mkdir -p /etc/apt/keyrings',
        'curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg',
        'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null',
        'apt-get update -y',
        'apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin',
        'systemctl enable docker && systemctl start docker',
        'usermod -aG docker ubuntu',
        '',
        '# Download Nucleus stack from GitHub',
        'mkdir -p /tmp/nucleus-setup',
        'ENCODED_BUILD="${NUCLEUS_BUILD//+/%2B}"',
        'curl -fSL "${GITHUB_REPO_URL}/${ENCODED_BUILD}.tar.gz" -o /tmp/nucleus-setup/${NUCLEUS_BUILD}.tar.gz',
        '',
        '# Extract nucleus stack',
        'mkdir -p /opt/ove',
        'cd /opt/ove',
        'if [ -f /tmp/nucleus-setup/${NUCLEUS_BUILD}.tar.gz ]; then tar -xzf /tmp/nucleus-setup/${NUCLEUS_BUILD}.tar.gz; fi',
        'chown -R ubuntu:ubuntu /opt/ove',
        '',
        '# Retrieve secrets from Secrets Manager',
        'ADMIN_SECRET=$(aws secretsmanager get-secret-value --secret-id ${ADMIN_SECRET_ARN} --region ${REGION} --query SecretString --output text)',
        'SERVICE_SECRET=$(aws secretsmanager get-secret-value --secret-id ${SERVICE_SECRET_ARN} --region ${REGION} --query SecretString --output text)',
        'ADMIN_PASSWORD=$(echo ${ADMIN_SECRET} | jq -r .password)',
        'SERVICE_PASSWORD=$(echo ${SERVICE_SECRET} | jq -r .password)',
        '',
        '# Get instance metadata via IMDSv2',
        'TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")',
        'PRIVATE_IP=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)',
        'PRIVATE_HOSTNAME=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/local-hostname)',
        '',
        '# Generate nucleus-stack.env and start services',
        'NUCLEUS_DIR=$(find /opt/ove -maxdepth 2 -type d -name base_stack | head -1)',
        'if [ -n "$NUCLEUS_DIR" ]; then',
        '  cd "$NUCLEUS_DIR"',
        '  cat > nucleus-stack.env << EOF',
        'ACCEPT_EULA=1',
        'SECURITY_REVIEWED=1',
        'SERVER_IP_OR_HOST=${PRIVATE_IP}',
        'INSTANCE_NAME=nucleus',
        'MASTER_PASSWORD=${ADMIN_PASSWORD}',
        'SERVICE_PASSWORD=${SERVICE_PASSWORD}',
        'DATA_ROOT=/var/lib/omni/data',
        'LFT_COMPRESSION=0',
        'API_PORT=3009',
        'API_PORT_2=3019',
        'META_DUMP_PORT=5555',
        'SERVICE_API_PORT=3006',
        'LFT_PORT=3030',
        'WEB_PORT=8080',
        'DISCOVERY_PORT=3333',
        'AUTH_PORT=3100',
        'AUTH_LOGIN_FORM_PORT=3180',
        'SEARCH_PORT=3400',
        'TAGGING_PORT=3020',
        'METRICS_PORT=3010',
        'CONTAINER_SUBNET=192.168.2.0/24',
        'REGISTRY=nvcr.io/nvidia/omniverse',
        'ENABLE_VERSIONING=1',
        'CORE_VERSION=1.14.17',
        'DISCOVERY_VERSION=1.4.9',
        'AUTH_VERSION=1.4.9',
        'SEARCH_VERSION=3.2.5',
        'THUMBNAILING_VERSION=1.5.6',
        'TAGGING_VERSION=3.1.6',
        'NAV3_VERSION=3.3.2',
        'USE_SAML_SSO=0',
        'SSO_GW_ADDRESS=',
        'FEDERATION_META_FILE=./saml/federation.meta.blank.xml',
        'SAML_LOGIN_URL=',
        'SAML_SSO_ACS_URL=',
        'SAML_SSO_DESTINATION=',
        'SAML_SSO_NAMEID_FORMAT=',
        'SAML_SSO_NAME=SSO',
        'SAML_SSO_IMAGE=',
        'CREDENTIAL_UI_VISIBLE=True',
        'SAML_SSO_MAX_BOUNCEBACK_URL_LENGTH=16380',
        'SSL_INGRESS_HOST=',
        'SSL_INGRESS_PORT=443',
        'AUTH_ROOT_OF_TRUST_PUB=./secrets/auth_root_of_trust.pub',
        'AUTH_ROOT_OF_TRUST_PRI=./secrets/auth_root_of_trust.pem',
        'AUTH_ROOT_OF_TRUST_LONG_TERM_PUB=./secrets/auth_root_of_trust_lt.pub',
        'AUTH_ROOT_OF_TRUST_LONG_TERM_PRI=./secrets/auth_root_of_trust_lt.pem',
        'PWD_SALT=./secrets/pwd_salt',
        'LFT_SALT=./secrets/lft_salt',
        'DISCOVERY_REGISTRATION_TOKEN=./secrets/svc_reg_token',
        'EOF',
        '  chmod 600 nucleus-stack.env',
        '  [ -f generate-sample-insecure-secrets.sh ] && bash generate-sample-insecure-secrets.sh || true',
        '  COMPOSE_FILE=$(ls nucleus-stack-no-ssl.yml nucleus-stack.yml 2>/dev/null | head -1)',
        '  if [ -n "$COMPOSE_FILE" ]; then',
        '    docker compose -f $COMPOSE_FILE --env-file nucleus-stack.env pull || true',
        '    docker compose -f $COMPOSE_FILE --env-file nucleus-stack.env up -d',
        '  fi',
        'fi',
        '',
        '# Install CloudWatch Agent (if metrics enabled)',
        'if [ "${METRICS_ENABLED}" == "true" ]; then',
        '  wget -q https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb -O /tmp/cw-agent.deb',
        '  dpkg -i /tmp/cw-agent.deb',
        '  mkdir -p /opt/aws/amazon-cloudwatch-agent/etc',
        '  cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << \'CWEOF\'',
        '{"agent":{"metrics_collection_interval":60,"run_as_user":"root"},"metrics":{"namespace":"AppStreamOmniverse/Nucleus","append_dimensions":{"InstanceId":"${aws:InstanceId}"},"metrics_collected":{"cpu":{"measurement":["cpu_usage_idle","cpu_usage_user","cpu_usage_system"],"metrics_collection_interval":60,"totalcpu":true,"resources":["*"]},"mem":{"measurement":["mem_used_percent"],"metrics_collection_interval":60},"disk":{"measurement":["used_percent"],"metrics_collection_interval":60,"resources":["/","/opt/ove"]},"net":{"measurement":["bytes_sent","bytes_recv"],"metrics_collection_interval":60,"resources":["*"]}}}}',
        'CWEOF',
        '  /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json',
        'fi',
        '',
        '# Health check script',
        'cat > /opt/ove/healthcheck.sh << \'HCEOF\'',
        '#!/bin/bash',
        'STATUS="healthy"',
        'timeout 3 bash -c "echo | nc localhost 3009" > /dev/null 2>&1 || STATUS="unhealthy"',
        'curl -sf http://localhost:8080 > /dev/null 2>&1 || STATUS="unhealthy"',
        'echo "{\\\"status\\\": \\\"$STATUS\\\", \\\"timestamp\\\": \\\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\\\"}"',
        '[ "$STATUS" == "healthy" ] && exit 0 || exit 1',
        'HCEOF',
        'chmod +x /opt/ove/healthcheck.sh',
        '',
        'echo "=== Nucleus Bootstrap Completed at $(date) ==="',
      );

      // SSM Parameter: Store Nucleus private IP
      new ssm.StringParameter(this, 'NucleusEndpointParam', {
        parameterName: `/${config.projectName}/nucleus/endpoint`,
        stringValue: nucleusInstance.instancePrivateIp,
        description: 'Nucleus server private IP for Omniverse connections',
      });

      // Nucleus Metrics Lambda + API endpoints (conditional)
      if (nucleusMetricsEnabled) {
        const nucleusLambdaSg = new ec2.SecurityGroup(this, 'NucleusLambdaSg', {
          vpc,
          description: 'Security group for Nucleus metrics Lambda',
          allowAllOutbound: true,
        });

        nucleusSg.addIngressRule(nucleusLambdaSg, ec2.Port.tcp(3009), 'Lambda probe on API port');
        nucleusSg.addIngressRule(nucleusLambdaSg, ec2.Port.tcp(8080), 'Lambda probe on web UI port');

        const nucleusMetricsLambda = new lambda.Function(this, 'NucleusMetricsCollector', {
          runtime: lambda.Runtime.PYTHON_3_12,
          handler: 'index.handler',
          code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/nucleus-metrics')),
          timeout: cdk.Duration.seconds(30),
          memorySize: 256,
          vpc,
          vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
          securityGroups: [nucleusLambdaSg],
          environment: {
            NUCLEUS_INSTANCE_ID: nucleusInstance.instanceId,
            NUCLEUS_PRIVATE_IP: nucleusInstance.instancePrivateIp,
            REGION: config.region,
          },
        });

        nucleusMetricsLambda.addToRolePolicy(new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['cloudwatch:GetMetricStatistics', 'cloudwatch:GetMetricData', 'cloudwatch:PutMetricData'],
          resources: ['*'],
        }));

        nucleusMetricsLambda.addToRolePolicy(new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['ec2:DescribeInstances'],
          resources: ['*'],
        }));

        nucleusMetricsLambda.addToRolePolicy(new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['ssm:DescribeInstanceInformation'],
          resources: ['*'],
        }));

        // EventBridge: Invoke Lambda every 1 minute
        new events.Rule(this, 'NucleusMetricsSchedule', {
          schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
          targets: [new targets.LambdaFunction(nucleusMetricsLambda)],
        });

        // API Gateway: Nucleus endpoints
        const nucleusResource = api.root.addResource('nucleus');
        const nucleusStatusResource = nucleusResource.addResource('status');
        const nucleusMetricsResource = nucleusResource.addResource('metrics');

        nucleusStatusResource.addMethod('GET', new apigateway.LambdaIntegration(nucleusMetricsLambda), {
          apiKeyRequired: true,
        });
        nucleusMetricsResource.addMethod('GET', new apigateway.LambdaIntegration(nucleusMetricsLambda), {
          apiKeyRequired: true,
        });
      }

      // Nucleus Outputs
      new cdk.CfnOutput(this, 'NucleusInstanceId', {
        value: nucleusInstance.instanceId,
        description: 'Nucleus EC2 instance ID',
      });

      new cdk.CfnOutput(this, 'NucleusPrivateIp', {
        value: nucleusInstance.instancePrivateIp,
        description: 'Nucleus server private IP',
      });

      new cdk.CfnOutput(this, 'NucleusConnectionString', {
        value: `omniverse://${nucleusInstance.instancePrivateIp}`,
        description: 'Omniverse connection string for Nucleus',
      });

      new cdk.CfnOutput(this, 'NucleusWebUi', {
        value: `http://${nucleusInstance.instancePrivateIp}:8080`,
        description: 'Nucleus Navigator web UI URL (accessible from VPC)',
      });

      new cdk.CfnOutput(this, 'NucleusAdminSecretArn', {
        value: adminSecret.secretArn,
        description: 'Secrets Manager ARN for Nucleus admin credentials',
      });
    }

    // ──────────────────────────────────────────────
    // Outputs
    // ──────────────────────────────────────────────

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway URL',
    });

    new cdk.CfnOutput(this, 'ApiKeyValue', {
      value: apiKeyValue,
      description: 'API Key value for x-api-key header',
    });

    new cdk.CfnOutput(this, 'ImageImportRoleArn', {
      value: imageImportRole.roleArn,
      description: 'IAM role ARN for AppStream image import',
    });

    new cdk.CfnOutput(this, 'FleetName', {
      value: fleetName,
      description: 'AppStream fleet name',
    });

    new cdk.CfnOutput(this, 'AppStreamStackName', {
      value: stackName,
      description: 'AppStream stack name',
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'VPC ID',
    });

    new cdk.CfnOutput(this, 'FleetEnabled', {
      value: fleetEnabled ? 'true' : 'false',
      description: 'Whether fleet is deployed (set image.customImageName in config.json)',
    });
  }
}
