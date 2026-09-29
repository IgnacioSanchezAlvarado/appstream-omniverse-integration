# Dashboard Authentication Guide

[← Back to README](../README.md)

## Overview

The metrics dashboard uses Amazon Cognito for authentication. Self-registration is disabled — an admin user is created automatically during deployment, and can then create additional users.

## Admin User

An admin user is created automatically on first deploy using the email in `config.json`:

```json
"dashboard": {
  "adminEmail": "admin@example.com"
}
```

Set this to your email **before deploying**. You'll receive a temporary password via email.

## Login Flow

1. Open the dashboard URL (`DashboardUrl` from CDK outputs)
2. You'll be redirected to the Cognito hosted login page
3. Enter your email and temporary password (sent via email on first deploy)
4. Set a new password on first login
5. You'll be redirected back to the dashboard

## Create Additional Users

Use the `UserPoolId` from CDK outputs:

```bash
aws cognito-idp admin-create-user \
  --user-pool-id <UserPoolId> \
  --username user@example.com \
  --user-attributes Name=email,Value=user@example.com Name=email_verified,Value=true \
  --region eu-central-1
```

The user will receive an email with their temporary password.

## Manage Users

### List users
```bash
aws cognito-idp list-users \
  --user-pool-id <UserPoolId> \
  --region eu-central-1
```

### Delete a user
```bash
aws cognito-idp admin-delete-user \
  --user-pool-id <UserPoolId> \
  --username user@example.com \
  --region eu-central-1
```

### Reset a user's password
```bash
aws cognito-idp admin-set-user-password \
  --user-pool-id <UserPoolId> \
  --username user@example.com \
  --password NewPassword123! \
  --permanent \
  --region eu-central-1
```

## Session Details

- Sessions are stored in the browser's sessionStorage (cleared when the tab closes)
- Token expiry defaults to 1 hour — users are redirected to login when tokens expire
- Click **Logout** in the dashboard header to end the session

> **Production recommendation**: For production deployments, consider integrating Cognito with your corporate identity provider via SAML or OIDC federation for SSO.
