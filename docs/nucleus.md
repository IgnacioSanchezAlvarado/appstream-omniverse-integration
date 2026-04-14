# Nucleus Server Guide

[← Back to README](../README.md)

## Multi-User Collaboration

When `nucleus.enabled: true` in `config.json`, the stack deploys an NVIDIA Nucleus server in the same VPC for USD asset storage and real-time collaboration.

### Retrieve Admin Credentials

The admin password is stored in AWS Secrets Manager:

```bash
aws secretsmanager get-secret-value \
  --secret-id appstream-omniverse/nucleus/admin \
  --region eu-central-1 \
  --query SecretString --output text | jq .
```

Default admin username is `omniverse`.

### Create Users

1. From an AppStream session, double-click the **Nucleus Navigator** desktop shortcut (or open `http://<NucleusPrivateIp>:8080` in a browser)
2. Log in with the admin credentials above
3. Go to the admin panel and create individual user accounts
4. Share each user's credentials with them directly

Each user connects to Nucleus from Omniverse using their own credentials at `omniverse://<NucleusPrivateIp>`.

### Connect from Omniverse

The Nucleus connection is automatically configured at session login — no manual setup needed.

1. Open any Omniverse app in the AppStream session
2. In the content browser, the Nucleus server should appear under **Saved Servers**
3. Click it to connect — a browser login window will appear
4. Enter your Nucleus username and password
5. Save files to `omniverse://<NucleusPrivateIp>/Users/<your-username>/`

If the server doesn't appear in saved servers, enter `omniverse://<NucleusPrivateIp>` manually in the address bar. The IP is shown in `nucleus-info.txt` on the desktop.

> **Production recommendation**: For production deployments, integrate Nucleus with Amazon Cognito via SAML SSO for centralized user management. Nucleus supports SAML federation — configure a Cognito User Pool as the identity provider to enable admin-managed users, password policies, and MFA through the AWS Console.

## Session Features

Each AppStream session automatically configures the following at login:

### Auto-configured Nucleus connection

If Nucleus is deployed (`nucleus.enabled: true`), the logon script reads the server IP from SSM Parameter Store and:
- Pre-configures the Nucleus server in Omniverse's saved servers (`omniverse.toml`)
- Creates a **Nucleus Navigator** desktop shortcut (opens the web UI)
- Creates a **nucleus-info.txt** file on the desktop with connection details and storage guidance

### Kit App Template persistence

The Kit App Template at `C:\Omniverse\kit-app-template` is synced bidirectionally with the AppStream Home Folder:
- **First session**: The AMI-baked copy is backed up to the Home Folder
- **Returning sessions**: Your previous work is restored from the Home Folder
- **Background sync**: Changes are synced from `C:\Omniverse` to the Home Folder every 60 seconds

### File storage

- `C:\` — Local NTFS disk. Use this for development work (required for symlinks/junctions used by NVIDIA build tools). **Files here are lost when the session ends.**
- `D:\PhotonUser\My Files\Home Folder` — Persistent S3-backed storage that survives across sessions. Save any files you want to keep here. Note: does not support NTFS symlinks or junctions.
