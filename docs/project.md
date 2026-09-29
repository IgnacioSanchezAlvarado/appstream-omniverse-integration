# Project: appstream-omniverse

_Owner: igsalvar. Started: 2026-09-29. Status: ready to launch._

## Problem
The AppStream 2.0 + NVIDIA Omniverse POC (this repository, a copy of `aws-samples/sample-appstream-omniverse-integration`) streams Omniverse Kit from a GPU fleet in `eu-central-1`, but it only exists as code plus a deploy note. It has no card on the solution hub, no story or screenshots a customer can look at while the fleet is cold, and no machine-readable description of how to start and stop it, so the hub's Start/Stop control cannot drive it. The repository has also drifted: the upstream sample may be ahead, and a second checkout on the dev station holds seven uncommitted files nobody has reviewed. The platform does not deploy this demo; the owner does, once, by hand. Agents make it presentable and controllable from the hub.

## Target users
- The owner, an AWS solutions architect: opens the hub before a meeting, clicks Start, presents Omniverse streaming with the metrics dashboard, clicks Stop. Never remembers CLI commands during a meeting and never wants the fleet billing overnight.
- Colleagues browsing the hub: read the story, architecture and screenshots without any AWS access; may start the demo if the launcher allows them.
- Agents building the hub (`solution-hub`) and the control plane (`demo-launcher`): read `docs/showcase.md` and `launcher.json` from this checkout and must never need to read CDK code or ask a human.
- The owner as deployer: follows `docs/deploy-runbook.md` step by step, including quota requests and the 30 to 45 minute image build, without reopening the deploy note.

## Experience
1. On the hub, the `appstream-omniverse` card shows a tagline, tags, the state "stopped" and the hourly cost of one GPU instance. The project page shows the story, the architecture diagram, a gallery of screenshots and the repository link even while nothing is running.
2. The owner clicks Start. The launcher raises the fleet to one instance and starts it (plus the Nucleus EC2 instance when enabled). After 10 to 15 minutes the card reads "running" and the "Open the demo" button points to the metrics dashboard; the page explains that the Omniverse streaming URL is created per session from the AppStream stack.
3. The owner presents, then clicks Stop; the fleet drops to zero instances and stops, Nucleus stops, the card returns to "stopped". If forgotten, the launcher stops the demo after 120 minutes.
4. A first-time deployer opens `docs/deploy-runbook.md`, requests the two GPU quotas, waits for approval, then runs the README's steps in order and fills the placeholders in `launcher.json` documented in `docs/launcher-setup.md`.

## Features
Build order: the hub reads item 1 and the launcher reads item 2 as soon as they land; the upstream merge comes last so it never blocks the hub card.
- [must] Showcase content for the hub: `docs/showcase.md` and `docs/showcase/`.
  - First section with `tagline:` and `tags:` lines (tags: "Omniverse", "AppStream 2.0", "GPU streaming", "digital twin").
  - `## Story` written from the README: Omniverse Kit streamed from G6e (L40S) instances over NICE DCV, the metrics dashboard (FPS, latency, bandwidth, CPU), optional Nucleus collaboration.
  - `## Architecture` embedding `docs/showcase/architecture.png`, copied from the repository's `architecture.png`.
  - `docs/showcase/` holds the diagram and screenshots in display order (`01-...png`, `02-...png`). Until the owner supplies screenshots from a running session, use `images/appstream.png` and `images/dashboard.png` and put the word `placeholder` in those file names.
- [must] `launcher.json` at the repository root following the demo-launcher contract.
  - `name` `appstream-omniverse`, `title`, `provider` `appstream`, `region` `eu-central-1`, `max_running_minutes` 120.
  - `start` = UpdateFleet DesiredInstances 1 then StartFleet on the fleet named in `config.json` (`<projectName>-fleet`, today `appstream-omniverse-fleet`); `stop` = UpdateFleet DesiredInstances 0 then StopFleet, plus the Nucleus EC2 instance id to start and stop when `nucleus.enabled` is true.
  - `keep` = ["AppStream image", "CDK base stack", "dashboard"].
  - `hourly_cost_usd` for one `Accelerated.g6e.xlarge` AppStream instance; the README states no price, so use a placeholder with the note "owner fills from the AppStream pricing page".
  - `url_source`: the launcher returns the dashboard CloudFront URL (`DashboardUrl` stack output) as the demo link; the Omniverse streaming URL is created per session with `create-streaming-url` against stack `appstream-omniverse-stack`, as in the README's "Test It", and the hub says so next to the link.
  - Values that exist only after the owner's deploy (Nucleus instance id, dashboard URL, cost) are placeholders documented in `docs/launcher-setup.md` with the read-only command or console page that reveals each one.
- [must] Deploy runbook for the owner: `docs/deploy-runbook.md` reproducing the README's steps in order. Agents never run any of these commands.
  - Quota requests first: `L-472DE3D3` (image builder) and `L-2C3EA73C` (fleet instances), both at least 1 in `eu-central-1`, 1 to 2 business days.
  - `cd infra && npm install && cdk bootstrap && cdk deploy`; then `python scripts/prepare-ami.py` (30 to 45 minutes, updates `config.json`); then the second `cdk deploy` (fleet created stopped with zero instances).
  - Start commands (`update-fleet` DesiredInstances 1, `start-fleet`, `describe-fleets` state check, 10 to 15 minutes to RUNNING); Test It (streaming URL, `nvidia-smi`, dashboard).
  - Clean Up: stop the fleet, `cdk destroy`, manual deletion of the AppStream image, prepared AMI and snapshot, and the 7-day Secrets Manager deletion window when Nucleus is enabled.
  - Known security gaps table for the hub page: no WAF on CloudFront, Nucleus reached over HTTP on port 8080 inside the VPC, API key authentication on the metrics API. Take it from the README's security section when present after the upstream merge, otherwise write it from this list.
- [must] Repository hygiene.
  - Extend `.gitignore` with `.beads/` and `config.json` (today it ignores only `.beads/proxieddb/`), and commit `config.example.json` with the same keys and no deployed values.
  - Before touching `config.json`, check it for 12-digit account ids or secrets; today it holds only region, fleet sizing, a marketplace AMI id and the image name, so this is expected to pass. If anything sensitive is found, file a `needs:human` bead instead of committing.
  - `scripts/verify-showcase.sh` (bash, no dependencies) exits 0 only when `docs/showcase.md` exists with the four required parts, at least one PNG exists in `docs/showcase/` and `launcher.json` parses with `python3 -m json.tool`. This is the platform's `verify_cmd`.
- [must] README section "On the demo hub": the fleet is stopped between meetings, started and stopped from the hub through the demo-launcher, the hourly cost is shown on the card, the streaming URL is created per session; links to `docs/showcase.md`, `launcher.json` and `docs/deploy-runbook.md`.
- [must] Upstream reconciliation: fetch `aws-samples/sample-appstream-omniverse-integration` main and merge it into this repository's main via a pull request (merge, never force-push), resolving conflicts in favour of upstream for CDK and application code and keeping the files added above. File a `needs:human` question bead listing, by name only, the seven uncommitted files found in `~/projects/appstream-sample-test/sample-appstream-omniverse-integration/` (read-only `git status` there) so the owner decides whether to bring them in; do not copy them until the owner answers.
- [nice] A 20-second GIF of an Omniverse session in `docs/showcase/` for the gallery, once the owner has run the demo and provided the recording.
- [nice] A Mermaid architecture block in `docs/showcase.md` (VPC, fleet, Nucleus, API Gateway + Lambda, S3 + CloudFront) rendered client-side by the hub.

## Constraints
- No secrets, account ids or emails in any committed file; placeholders only for post-deploy values.
- Agents never deploy or destroy anything: no `cdk` commands, no `aws` write commands, never `scripts/prepare-ami.py`. Read-only `aws describe`/`get` calls are acceptable only to document a value and must not be needed to complete any feature.
- CDK and application code (`infra/`, `backend/`, `web/`, `scripts/prepare-ami.py`) are not modified except through the upstream reconciliation; everything else in this document is additive files or README text.
- Git: merge, never force-push; pull requests to `main` of `IgnacioSanchezAlvarado/appstream-omniverse-integration`.
- Region of the demo is `eu-central-1`; the hub and launcher live on the platform host and call into it, nothing here creates a URL, load balancer, certificate or Cognito resource.
- Known security gaps stay as they are (no WAF on CloudFront, Nucleus over HTTP); they are documented, not fixed, in this project.

## Tech stack
Markdown, JSON and bash only; no new dependencies, no build step. Existing code stays CDK TypeScript, Python 3.12 and React (unchanged).

## Success criteria and verification
- `bash scripts/verify-showcase.sh` exits 0 on the host from the repository root.
- `docs/showcase.md` contains `tagline:`, `tags:`, `## Story` and `## Architecture`, and the architecture image it references exists under `docs/showcase/`.
- `python3 -m json.tool launcher.json` succeeds and the file has `name`, `title`, `provider`, `region`, `start`, `stop`, `keep`, `hourly_cost_usd`, `url_source` and `max_running_minutes`.
- `git grep -nE '[0-9]{12}'` over committed files returns nothing that is an AWS account id (build numbers in `config.json` values such as the Nucleus build tag are not account ids; agents confirm and note any hit).
- A pull request merging upstream main exists (open or merged) and a `needs:human` bead lists the seven uncommitted file names.
- `https://hub.igsalvar.people.aws.dev/p/appstream-omniverse` shows the story, the architecture image, at least one screenshot and a Start/Stop control reading "stopped". QA reports this criterion as pending, not failed, while the hub showcase and the launcher features are not yet deployed.

## Test accounts and data
- Test identity: the platform QA identity (Cognito `qa-bot`, credentials in the platform state directory, never in this repository) for the hub page check.
- Sample inputs: none.
- Extra credentials: none.

## Budget
Daily budget: no limit. Total budget: no limit. (Set in the platform's Settings page when needed.)

## Change log
- 2026-09-29: Project enrolled from the owner's deploy note: showcase content and `launcher.json` for the hub and demo-launcher, a deploy runbook for the owner (quotas, image build, fleet start/stop, clean up, security gaps), repository hygiene with a verify script, a README hub section, and reconciliation with upstream `aws-samples/sample-appstream-omniverse-integration` plus a `needs:human` question on the seven uncommitted files in the other checkout; the platform never deploys this demo.
