# Langfuse Integration & Observability — Interview First, Then Architect

I want to integrate **Langfuse** with our **Eve/Vercel Agent projects**.

However, **do not start implementing anything yet**.

Your first task is to **interview me** so you can fully understand what I am trying to build, the constraints, our current architecture, and my expectations.

## Your role

Act as a senior **AI infrastructure / observability architect** with strong experience in:

* Langfuse
* Vercel AI SDK / Vercel Agents
* Eve Agent
* LLM observability
* Distributed tracing
* Self-hosted infrastructure
* Scaling
* Cost monitoring
* Evaluation pipelines
* Datasets and experiments
* Production AI systems

Do not make assumptions where an important architectural decision is unclear. Interview me first.

---

# Important: Research requirements

You have access to the following resources and MUST use them when relevant:

### Context7

We have the **Context7 plugin** available.

Use Context7 for **real-time documentation research** and current technical information.

Do **not rely only on your pretrained knowledge** when researching:

* Langfuse
* Vercel AI SDK
* Vercel Agents
* Eve Agent
* Related SDKs/APIs
* Current configuration options
* Current deployment/scaling recommendations

### Vercel

We also have the **Vercel plugin** available.

Use it when relevant to understand our Vercel setup, projects, deployments, and current Vercel capabilities.

### Eve Agent documentation

The Eve Agent documentation is available here:

https://eve.dev/docs

Research the current Eve Agent documentation when necessary.

### Langfuse skill

You already have the **Langfuse skill installed**.

Use the Langfuse skill rather than reinventing information that is already available through it.

The existence of this skill should also be documented in the final `CLAUDE.md`.

---

# First step: Interview me

Before creating any architecture or implementation plan, interview me.

Your questions should help you understand:

1. What our current Eve/Vercel Agent architecture looks like.
2. How many projects/agents we currently have.
3. How many projects we expect to have eventually.
4. How agents communicate with each other, if applicable.
5. Where the agents are deployed.
6. What infrastructure we already have.
7. Where Langfuse should be hosted.
8. What "self-hosted" means for our requirements.
9. Expected traffic and tracing volume.
10. Expected growth.
11. Availability and reliability requirements.
12. Data retention requirements.
13. Security and privacy requirements.
14. What LLM providers/models we use.
15. What costs we need to monitor.
16. What information we need in traces.
17. What level of trace granularity we expect.
18. What the ideal Langfuse UI experience should look like.
19. What metadata we need attached to traces.
20. How we want to identify users, sessions, agents, projects, environments, and requests.
21. Whether we need distributed/cross-agent tracing.
22. What datasets we eventually want.
23. What experiments we eventually want.
24. What evaluation workflows we eventually want.
25. What our development/staging/production environments look like.
26. What CI/CD system we use.
27. What logging/monitoring infrastructure already exists.
28. What databases, queues, storage, or other infrastructure we already operate.
29. What our budget and infrastructure constraints are.
30. What "production ready" means for us.

Do not ask all questions at once if that would make the interview unnecessarily difficult.

Conduct the interview intelligently and adapt the next questions based on my answers.

If something I say is ambiguous, investigate it before making architectural decisions.

---

# Overall vision

The long-term goal is to build a **centralized Langfuse observability platform** for all of our Eve/Vercel Agent projects.

Langfuse should become the central place where we can understand:

* What every agent is doing
* Why an agent made a particular decision
* Every important LLM interaction
* Agent/tool execution
* Latency
* Errors
* Token usage
* Model usage
* Costs
* Sessions
* Users
* Projects
* Environments
* Agent workflows
* Failures
* Performance
* Quality
* Evaluations
* Experiments

We want this to work across **all current and future Eve/Vercel Agent projects**, rather than creating a separate observability setup for every project.

The architecture should therefore be designed as a **shared, centralized, scalable Langfuse platform**.

---

# Critical priority: tracing quality

The most important part of the initial implementation is **excellent tracing**.

The traces must be:

* Detailed
* Structured
* Consistent
* Easy to understand
* Easy to navigate
* Useful for debugging
* Useful for performance analysis
* Useful for cost analysis
* Useful for understanding agent behavior

A developer should be able to open a trace in Langfuse and quickly understand:

> What happened from the beginning of the request until the final response?

The trace should make the complete execution flow obvious.

We need to carefully design things such as:

* Trace structure
* Spans
* Generations
* Events
* Metadata
* Attributes
* Sessions
* Users
* Projects
* Environments
* Agent names
* Agent versions
* Model names
* Token usage
* Costs
* Latency
* Tool calls
* Tool inputs/outputs where appropriate
* Errors
* Retries
* External API calls
* Important agent decisions
* Workflow steps
* Parent/child relationships

Avoid creating noisy traces that contain useless information.

The goal is **high signal, not simply maximum logging**.

Research the current Langfuse and Eve/Vercel capabilities and determine the cleanest way to achieve this.

---

# Phase 1 — ONLY hosting, scaling, and tracing

For the first phase, do **NOT** try to implement the entire Langfuse platform.

Phase 1 should focus primarily on:

## 1. Langfuse self-hosting

Design the self-hosted Langfuse architecture.

Determine:

* Recommended deployment architecture
* Required services
* Database requirements
* Storage requirements
* Networking
* Secrets
* Authentication
* Security
* Backups
* Disaster recovery
* Updates
* Monitoring
* Logging
* High availability
* Failure scenarios

## 2. Scaling

The Langfuse installation must be designed to scale.

Think about:

* Number of Eve/Vercel Agent projects
* Trace volume
* Concurrent requests
* Data ingestion
* Database growth
* Storage growth
* Retention
* Horizontal scaling
* Bottlenecks
* Cost
* Future growth

Do not over-engineer the first version, but make sure the architecture has a clear path to scale.

## 3. Centralized architecture

Langfuse should be a shared platform for all our Eve/Vercel Agent projects.

Design a clear organizational model for:

* Projects
* Environments
* Agents
* Users
* Sessions
* Teams
* Services

We need to understand how multiple independent agent projects should be represented inside Langfuse.

## 4. Tracing

This is the **highest-priority implementation area**.

Design and implement a consistent tracing strategy across Eve/Vercel Agent projects.

The tracing architecture should be reusable so that adding another agent project does not require reinventing the integration.

Think about creating a shared tracing/instrumentation layer or standard that every project can follow.

---

# Future phases

Do not implement these yet, but design the architecture so they can be added later.

## Phase 2 — Cost & usage monitoring

Eventually we want to monitor:

* Token usage
* LLM costs
* Model usage
* Cost per project
* Cost per agent
* Cost per user/session where appropriate
* Cost trends
* Expensive workflows
* Cost anomalies

## Phase 3 — Datasets

Eventually we want to build and manage datasets in Langfuse.

Think about how traces and production examples could eventually become useful evaluation datasets.

## Phase 4 — Experiments

Eventually we want to run experiments around:

* Prompts
* Models
* Agent configurations
* Workflows
* Retrieval
* Tool usage

## Phase 5 — Evaluations

Eventually we want a proper evaluation system including:

* Automated evaluations
* Human evaluations
* LLM-as-a-judge where appropriate
* Regression testing
* Quality metrics
* Experiment comparisons
* Production evaluation

But again:

**Do not implement these phases now.**

The architecture should simply avoid blocking them later.

---

# Architectural principle

The most important principle is:

> Build the foundation correctly before adding advanced features.

Phase 1 should produce a robust, understandable, scalable Langfuse platform with excellent tracing.

Do not rush into datasets, experiments, or evaluations before the underlying observability architecture is correct.

---

# After the interview

Once you have enough information from me, create a `CLAUDE.md`.

The `CLAUDE.md` should describe the **global idea and architectural direction of this project**.

It should include:

## Project objective

Why we are building this Langfuse platform.

## Long-term vision

What the complete observability platform should eventually become.

## Current phase

Clearly state that we are currently in:

**Phase 1 — Self-hosted Langfuse hosting, scaling, and high-quality tracing.**

## Architecture

Document the agreed architecture and explain the important design decisions.

## Eve/Vercel Agent integration

Explain how Eve/Vercel Agent projects are expected to integrate with Langfuse.

## Tracing philosophy

Document what a good trace should look like and the standards every project should follow.

## Project organization

Explain how multiple Eve/Vercel Agent projects should be represented and organized.

## Scaling strategy

Document how the Langfuse infrastructure should scale as our agent ecosystem grows.

## Security and infrastructure

Document the agreed security, networking, secrets, backup, and reliability principles.

## Future roadmap

Document the future phases:

1. Hosting / Scaling / Tracing
2. Cost & Usage
3. Datasets
4. Experiments
5. Evaluations

## Research/tooling requirements

Explicitly document that:

* Context7 is available and should be used for current/realtime technical research.
* The Vercel plugin is available and should be used when relevant.
* Eve Agent documentation is available at https://eve.dev/docs.
* The Langfuse skill is already installed and should be used.
* Technical decisions should be based on current documentation rather than relying solely on pretrained knowledge.

---

# Important working rules

1. **Interview me first.**
2. Do not start coding before the interview is complete.
3. Do not make major architectural assumptions without validating them.
4. Use current documentation and available tools/skills for technical research.
5. Prefer simple, maintainable architecture over unnecessary complexity.
6. Design for scale, but do not prematurely over-engineer.
7. Treat tracing quality as the highest priority in Phase 1.
8. Make tracing reusable across all current and future Eve/Vercel Agent projects.
9. Keep future datasets, experiments, evaluations, and cost monitoring in mind without implementing them prematurely.
10. The final `CLAUDE.md` should be understandable to any developer joining the project later.
11. Clearly separate **what we are implementing now** from **what is planned for later**.
12. Before finalizing the architecture, validate important technical assumptions against current Langfuse, Vercel, and Eve documentation.

Start by interviewing me.
