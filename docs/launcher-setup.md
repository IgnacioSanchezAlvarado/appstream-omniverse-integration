# Connecting this demo to the demo-launcher

The demo-launcher (the control plane behind the Start/Stop control on the solution hub
card) reads `launcher.json` at the root of this repository. The file uses the `appstream`
provider of the launcher's `docs/demos.schema.md`: Start runs `UpdateFleet` with
`DesiredInstances=1` and `StartFleet` on fleet `appstream-omniverse-fleet`, then
`StartInstances` on the Nucleus EC2 instance when one is configured; Stop runs
`UpdateFleet` with `DesiredInstances=0`, `StopFleet` and `StopInstances`. The AppStream
image, the CDK base stack and the dashboard stay deployed (`keep`). The launcher stops the
demo on its own after `max_running_minutes` (120).

Everything that only exists after the owner's deploy is a placeholder. Two kinds appear
in `launcher.json`:

- `${demo.appstream_omniverse.<field>}` placeholders are resolved by the launcher from
  its own gitignored `config.json` (block `demos.appstream_omniverse`). Account ids, role
  ARNs and instance ids never land in this repository.
- `<UPPER_CASE>` tokens mark values documented here for the owner: the number or URL to
  copy, and where it goes.

Do these steps once, after the two `cdk deploy` runs of the README (see
`docs/deploy-runbook.md`). Every command below is read-only. All AWS commands run in
`eu-central-1`, the region of this demo; nothing here creates or changes a resource.

## 1. Placeholders and where each value comes from

| Placeholder | Reveals it (read-only) | Where the value goes |
|---|---|---|
| `<NUCLEUS_INSTANCE_ID>` | Only when `nucleus.enabled` is `true` in `config.json`. Stack output `NucleusInstanceId` (command A below), or `aws ec2 describe-instances` filtered by tag `Project=appstream-omniverse` (command B). Console: EC2 > Instances, filter `tag:Project = appstream-omniverse`. | Launcher `config.json` > `demos.appstream_omniverse.nucleus_instance_id`, read by `start.nucleus_instance_id` and `stop.nucleus_instance_id` of `launcher.json` through `${demo.appstream_omniverse.nucleus_instance_id}`. Leave `""` when Nucleus is disabled. |
| `<DASHBOARD_URL>` | Stack output `DashboardUrl` of `AppStreamOmniverseStack` (command C). Console: CloudFormation > Stacks > `AppStreamOmniverseStack` > Outputs. Present only when `monitoring.dashboardEnabled` is `true`. | `url_source.value` in `launcher.json`, and optionally `links.dashboard` (the launcher shows it as "Open the demo"). |
| `<HOURLY_COST_USD>` | Filled: `3.52` (3.515 USD per `Accelerated.g6e.xlarge` fleet instance-hour, on-demand, eu-central-1, retrieved 2026-09-29) from the AWS Price List API, read-only: `aws pricing get-products --service-code AmazonAppStream --region us-east-1 --filters Type=TERM_MATCH,Field=location,Value="EU (Frankfurt)" Type=TERM_MATCH,Field=instanceType,Value=Accelerated.g6e.xlarge` (use the product with `instanceFunction` `Fleet`, usagetype `EUC1-Accelerated.g6e.xlarge-fl`). Nucleus `c5.2xlarge` Linux hour (0.388 USD, not included; add it when `nucleus.enabled` is `true`): `aws pricing get-products --service-code AmazonEC2 --region us-east-1 --filters Type=TERM_MATCH,Field=regionCode,Value=eu-central-1 Type=TERM_MATCH,Field=instanceType,Value=c5.2xlarge Type=TERM_MATCH,Field=operatingSystem,Value=Linux Type=TERM_MATCH,Field=tenancy,Value=Shared Type=TERM_MATCH,Field=preInstalledSw,Value=NA Type=TERM_MATCH,Field=capacitystatus,Value=Used Type=TERM_MATCH,Field=licenseModel,Value="No License required"`. To override, the owner fills from the AppStream 2.0 pricing page, <https://aws.amazon.com/appstream2/pricing/> (region `Europe (Frankfurt)`, `On-Demand`, `Accelerated.g6e.xlarge`), and <https://aws.amazon.com/ec2/pricing/on-demand/>. | `hourly_cost_usd` in `launcher.json` (the launcher requires a number). Keep `hourly_cost_usd_source` as the record of what the number covers, the region, the date and the Nucleus price. |
| `${demo.appstream_omniverse.account}` | `aws sts get-caller-identity --query Account --output text` with the demo account's profile. | Launcher `config.json` > `demos.appstream_omniverse.account`. Never in this repository. |
| `${demo.appstream_omniverse.role_arn}` | Output `RoleArn` of `DemoLauncherTargetRoleStack` after the launcher's target role is deployed into the demo account (step 3). | Launcher `config.json` > `demos.appstream_omniverse.role_arn`. Never in this repository. |
| `${demo.appstream_omniverse.nucleus_instance_id}` | Same value as `<NUCLEUS_INSTANCE_ID>`. | Launcher `config.json` > `demos.appstream_omniverse.nucleus_instance_id`. |

Not placeholders, already fixed by `config.json` of this repository: fleet
`appstream-omniverse-fleet` and AppStream stack `appstream-omniverse-stack`
(`projectName` + `-fleet` / `-stack`), region `eu-central-1`.

### Commands

Replace `<demo-profile>` with the CLI profile of the demo account.

```bash
# A. Nucleus instance id from the stack output (empty when Nucleus is disabled)
aws cloudformation describe-stacks --stack-name AppStreamOmniverseStack \
  --query "Stacks[0].Outputs[?OutputKey=='NucleusInstanceId'].OutputValue" --output text \
  --region eu-central-1 --profile <demo-profile>

# B. Nucleus instance id by tag (the CDK app tags every resource Project=appstream-omniverse)
aws ec2 describe-instances \
  --filters "Name=tag:Project,Values=appstream-omniverse" \
            "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query "Reservations[].Instances[].[InstanceId,State.Name,InstanceType]" --output table \
  --region eu-central-1 --profile <demo-profile>

# C. Dashboard URL (CloudFront) from the stack output
aws cloudformation describe-stacks --stack-name AppStreamOmniverseStack \
  --query "Stacks[0].Outputs[?OutputKey=='DashboardUrl'].OutputValue" --output text \
  --region eu-central-1 --profile <demo-profile>

# D. Confirm the fleet and stack names the launcher will act on
aws appstream describe-fleets --names appstream-omniverse-fleet \
  --query "Fleets[0].[Name,State,ComputeCapacityStatus.Desired,InstanceType]" --output table \
  --region eu-central-1 --profile <demo-profile>
aws appstream describe-stacks --names appstream-omniverse-stack \
  --query "Stacks[0].Name" --output text --region eu-central-1 --profile <demo-profile>
```

The Omniverse streaming URL is not a placeholder and not stored anywhere: it is created
per session with `aws appstream create-streaming-url` against stack
`appstream-omniverse-stack` and fleet `appstream-omniverse-fleet` once the fleet is
`RUNNING` (README, "Test It"). `url_source.note` in `launcher.json` carries that sentence
so the hub can show it next to the dashboard link.

## 2. Fill the launcher's `config.json`

In the demo-launcher checkout the block `demos.appstream_omniverse` already exists in
`config.example.json`. Copy it into `config.json` (never committed) and set:

```json
"demos": {
  "appstream_omniverse": {
    "account": "<account id from aws sts get-caller-identity>",
    "region": "eu-central-1",
    "role_arn": "<RoleArn output of DemoLauncherTargetRoleStack>",
    "nucleus_instance_id": "<NUCLEUS_INSTANCE_ID or empty string when Nucleus is disabled>"
  }
}
```

Then, in this repository, put the dashboard URL into `url_source.value` (and
`links.dashboard` if the card should link to it) and the price into `hourly_cost_usd`,
commit, and sync the registry from the launcher checkout so `demos.json` picks up this
repository's `launcher.json`:

```bash
python3 scripts/sync-registry.py <path-to-this-checkout>
```

The sync refuses a `launcher.json` that contains a twelve-digit number or an e-mail
address, which is why the account id and role ARN stay in the launcher's `config.json`.

## 3. Deploy the target role into the demo account

Start does nothing until the launcher can assume a role in the demo account.
`DemoLauncherTargetRoleStack` is context-gated in the demo-launcher checkout and, for
`target=appstream`, grants only the fleet calls on `appstream-omniverse-fleet` and the
start/stop calls on the Nucleus instance (see the launcher's `docs/demos.schema.md`,
"adding a demo"). The owner deploys it; this repository never does:

```bash
npx cdk deploy DemoLauncherTargetRoleStack \
  -c target=appstream -c demo=appstream-omniverse \
  -c trusted_role_arns=<launcher-role-arn>,<AutostopRoleArn> \
  --profile <demo-profile> --region eu-central-1
```

`trusted_role_arns` lists the launcher Lambda role and the `AutostopRoleArn` output of the
launcher's main stack. Put the stack's `RoleArn` output into `role_arn` above.

## 4. Verify

In the demo-launcher checkout:

```bash
python3 scripts/demo.py appstream-omniverse status
```

The command reports the fleet state and desired capacity (and the Nucleus instance state
when configured). `start` and `stop` on the same script drive the sequence recorded under
`start.sequence` and `stop.sequence` in `launcher.json`; the fleet needs 10 to 15 minutes
to reach `RUNNING`, and the launcher stops the demo automatically after 120 minutes.
