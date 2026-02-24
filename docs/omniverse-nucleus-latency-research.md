# Omniverse Connector Latency Through Nucleus — Research Notes

> Internal reference doc. Not for distribution.
> Context: AppStream streaming latency ~30ms, Nucleus API probe ~10ms (same VPC, eu-central-1).

---

## Short Answer

**Negligible impact.** The Omniverse app runs on the AppStream G6e instance. Nucleus is in the same VPC. The actual network round-trip between the AppStream instance and Nucleus is sub-1ms. Nucleus sync adds nothing noticeable to the user experience.

---

## What Omniverse Connectors Actually Do

Connectors communicate with Nucleus via **USD Live** (WebSocket on port 3009). There are three distinct data flows:

| Operation | Port | Data | Latency impact |
|---|---|---|---|
| Initial scene load | 3030 (LFT) | Bulk USD asset transfer | One-time cost (seconds), not per-frame |
| Live edit sync | 3009 (API) | Incremental USD deltas (kilobytes) | Sub-5ms in same VPC |
| Asset read/write | 3009 (API) | USD layer reads | Sub-1ms VPC network |

Live sync runs at **~60Hz (16ms intervals)**. Each delta is a small USD property change, not a full file rewrite. At same-VPC distances this is effectively free.

---

## The Two Latency Paths Are Independent

```
User input (keyboard/mouse)
        ↓
AppStream G6e instance
   ├── Renders scene → streams video to user   ← 30ms  (AppStream InSessionLatency)
   └── Sends USD delta → Nucleus               ← <1ms  (same VPC, same AZ)
                              ↓
                     Other OV clients receive delta
                     (only active in multi-user Live Sessions)
```

The **30ms AppStream streaming latency is the dominant and only user-perceived latency**. It is set by the video encoding/streaming pipeline between the AppStream instance and the user's browser — Nucleus is not in this path at all.

---

## Multi-User Live Sessions

In a Live Session with multiple collaborators, the effective latency for seeing a peer's change is:

```
peer's change → Nucleus (<1ms VPC) → your AppStream instance → rendered + streamed to you (30ms)
```

Total: ~30ms. The Nucleus hop is negligible. This is well within the threshold of human perception (~80–100ms).

NVIDIA's supported range for live editing is **8–30 concurrent users** per session. Above 15 users, delta propagation load scales quadratically:

```
load ∝ users × (users - 1) × properties_changed × updates_per_second
```

For a POC demo with 2–5 users this is completely negligible.

---

## When Nucleus Does Matter: Scene Loading

The only scenario where Nucleus performance is user-visible is the **initial cold scene load** — the LFT bulk transfer of USD assets. For large scenes:

- Small scenes (<1GB): loads in seconds, unnoticeable
- Medium scenes (1–10GB): 10–60 seconds depending on storage throughput
- Large scenes (10GB+): NVIDIA recommends NVMe-backed storage for production

Current POC config: `c5.2xlarge` with 512GB gp3 EBS. Adequate for demo scenes. For production or large asset libraries, consider `i3en` or `i4i` instances with NVMe storage.

---

## What the Dashboard "Nucleus API Latency" Metric Actually Measures

The 10ms value shown in the dashboard is **not** the USD Live sync latency. It is:

- An HTTP GET probe from a Lambda function to the Nucleus Navigator web UI (port 8080)
- Measures: "is Nucleus reachable and the web UI responding?"
- Represents: Lambda → VPC → Nucleus HTTP, not AppStream instance → Nucleus WebSocket

The actual connector latency (AppStream G6e instance ↔ Nucleus port 3009) is sub-1ms and is not currently instrumented.

**Dashboard label recommendation**: Call this metric "Nucleus health probe" or "Nucleus API availability" rather than implying it represents collaboration sync latency.

---

## NVIDIA Network Guidance

NVIDIA does not publish specific numeric latency thresholds for Nucleus in their public docs. Their guidance:

- "Low latency connectivity" required for live collaboration
- NVMe storage recommended for 15+ concurrent live editors
- No hard limits published for single-user or small-group scenarios

Same-VPC deployment (as in this POC) satisfies all published requirements with significant headroom.

---

## Summary for Customer Demos

| Concern | Reality |
|---|---|
| "Will Nucleus add latency to my AppStream session?" | No — Nucleus is not in the rendering or streaming path |
| "Will live collaboration feel laggy?" | No — same-VPC delta sync is sub-1ms; user sees peer changes in ~30ms (the AppStream stream) |
| "What's the bottleneck?" | AppStream streaming latency (30ms) is the only latency users feel |
| "When should I worry about Nucleus perf?" | Only for large initial scene loads (>1GB assets) |
