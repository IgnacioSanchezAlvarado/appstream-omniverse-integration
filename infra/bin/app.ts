#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { AppStreamOmniverseStack } from '../lib/appstream-stack';
import * as config from '../../config.json';

const app = new cdk.App();
new AppStreamOmniverseStack(app, 'AppStreamOmniverseStack', {
  env: {
    region: config.region,
  },
  tags: config.tags,
});
