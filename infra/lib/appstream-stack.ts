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
import * as path from 'path';
import * as config from '../../config.json';

// Phase 1: Set customImageName = "" → deploys VPC, API, dashboard, image import role
// Phase 2: Set customImageName = "your-image" → adds fleet, stack, association

const fleetEnabled = config.image.customImageName !== '';
const dashboardEnabled = config.monitoring.dashboardEnabled;

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
      const fleet = new appstream.CfnFleet(this, 'Fleet', {
        name: fleetName,
        instanceType: config.fleet.instanceType,
        fleetType: config.fleet.fleetType,
        imageName: config.image.customImageName,
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
      functionName: `${config.projectName}-metrics-collector`,
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
      functionName: `${config.projectName}-session-manager`,
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
