# AI Adoption Plans — Index

A curated set of AI adoption plans and blueprints, summarized using a common 15-section structure. Companion to [ideas_catalog.md](../ideas_catalog.md) — the catalog lists individual *use cases*; this folder describes end-to-end *adoption plans* (frameworks, case studies, industry blueprints, vendor reference architectures).

## Common Structure

Every plan file uses the same template:

1. Frontmatter — `title`, `type`, `source`, `source_url`, `date`, `industries`, `maturity`, `verification`, plus catalog-aligned `tags`
2. Executive Snapshot
3. Context & Strategic Drivers
4. Objectives & Target Outcomes
5. Adoption Roadmap / Phases
6. **Training & Workforce Enablement**
7. **Product Ideation & Development**
8. **Cost Reduction Levers**
9. **Portfolio & Competitive Positioning**
10. **Market Expansion Plays**
11. Technology & Architecture
12. Governance, Risk & Responsible AI
13. KPIs & Measured Outcomes
14. Risks, Constraints & Open Questions
15. References

The five bold sections directly answer the consultant's collection brief: training, products ideation/development, cost reduction, portfolio competitiveness, markets expansion.

## Tag taxonomy

Tags reuse the [ideas_catalog.md](../ideas_catalog.md) taxonomy (`function/`, `industry/`, `tech/`, `audience/`, `value/`, `maturity/`) so the two artifacts can be cross-filtered with the same grep / search patterns.

## Verification levels

Each file carries a `verification:` frontmatter field:

- `web-search-2026-05` — content built from live web search results in May 2026; URLs are real but content phrasing should be re-confirmed before client delivery if you cite specific quotes.
- `vendor-docs-fetched` — content quoted/cited directly from vendor documentation that was fetched in-session.
- `training-knowledge-cutoff-2026-01` — content reconstructed from training knowledge (used where live fetch was unavailable); URLs are canonical vendor pages but should be re-verified.

## Consultancy Frameworks (6)

The published transformation methodologies from the major management consultancies.

- [McKinsey — Rewired](consultancy-mckinsey-rewired.md) — six capabilities + AI Transformation Manifesto + Rewired 2.0
- [BCG — AI at Scale & 10-20-70](consultancy-bcg-ai-at-scale.md) — 10% algorithms, 20% tech, 70% people / process
- [Bain — AI Playbook (Sage + OpenAI Alliance)](consultancy-bain-ai-playbook.md) — top-down diagnostics + OpenAI Deployment Company
- [Deloitte — Trustworthy AI + State of GenAI](consultancy-deloitte-trustworthy-ai.md) — 7-dimension Trustworthy AI; quarterly survey benchmark
- [Accenture — Total Enterprise Reinvention](consultancy-accenture-total-enterprise-reinvention.md) — Reinventors / Transformers; no-regret + strategic bets
- [Gartner — AI Maturity + AI TRiSM](consultancy-gartner-ai-maturity-trism.md) — 5-stage model + 7-workstream roadmap + AI TRiSM

## Company Case Studies (8)

Real enterprise rollouts with reported outcomes.

- [PwC — Global Microsoft 365 Copilot rollout](case-pwc-copilot-global.md) — 136 countries, $150M time savings, 200K+ licenses
- [JPMorgan Chase — LLM Suite](case-jpmorgan-llm-suite.md) — 200K+ users, model-agnostic gateway, ~100 GenAI use cases
- [Walmart — Sparky, Wally & Wallaby LLM](case-walmart-sparky-wallaby.md) — agentic shopping + retail-tuned LLM
- [Carrefour — Hopla ChatGPT shopping assistant](case-carrefour-hopla.md) — GPT-4 conversational grocery + procurement AI
- [Moderna — mChat → ChatGPT Enterprise](case-moderna-mchat-chatgpt-enterprise.md) — 750+ GPTs, ~3,000 users, 15-product pipeline ambition
- [Klarna — OpenAI customer service (and the 2025 course correction)](case-klarna-ai-customer-service.md) — 67% automation, $40M, then human-AI blend
- [Coca-Cola — Create Real Magic + Y3000](case-coca-cola-create-real-magic.md) — generative marketing + AI co-created product
- [Bain & Company (internal) — Sage + ChatGPT Enterprise](case-bain-internal-sage.md) — proprietary RAG + 2,000+ MyGPTs + OpenAI alliance

## Industry Blueprints (6)

Sector-level adoption patterns synthesized from consultancy, vendor, and regulator material.

- [Banking & Financial Services](industry-banking-financial-services.md) — LLM gateways, agentic CS, fraud, code modernization
- [Retail & CPG](industry-retail-cpg.md) — generative content, conversational commerce, intelligent supply chain
- [Healthcare & Pharma](industry-healthcare-pharma.md) — ambient documentation, RCM, payer ops, drug discovery
- [Manufacturing & Industrials](industry-manufacturing-industrials.md) — predictive maintenance, digital twins, Industrial Copilots
- [Insurance](industry-insurance.md) — agentic FNOL, underwriting copilots, fraud, with human oversight
- [Telecom](industry-telecom.md) — TM Forum AI-Native Blueprint + autonomous networks + AI-RAN

## Vendor Reference Architectures (5)

The official adoption frameworks published by the major cloud / AI vendors.

- [Microsoft — Cloud Adoption Framework for AI](vendor-microsoft-caf-ai.md) — Strategy → Plan → Ready → Govern → Secure → Manage
- [AWS — CAF for AI + Well-Architected ML / GenAI Lenses](vendor-aws-caf-ai.md) — six perspectives + Project → Foundation → Production → Scale
- [Google Cloud — AI Adoption Framework + Vertex AI / Gemini Enterprise](vendor-google-ai-adoption-framework.md) — Tactical → Strategic → Transformational; six themes
- [NVIDIA — Enterprise AI Reference Architecture (AI Factory)](vendor-nvidia-enterprise-ai-ra.md) — full-stack hardware + NIM + NeMo + Blueprints
- [Databricks — Data Intelligence Platform + Mosaic AI](vendor-databricks-data-intelligence.md) — Lakehouse + Mosaic AI + Unity Catalog

## How to use this folder

- **Cross-filter with the ideas catalog.** Plans here cite the use cases from [ideas_catalog.md](../ideas_catalog.md); use the shared tag taxonomy to find the plan(s) that match a given idea, or the ideas that fit inside a plan.
- **Pull a plan as the spine of an engagement.** Each file's section 4 (Adoption Roadmap / Phases) can be lifted into a client proposal; section 12 (KPIs) gives benchmark numbers.
- **Combine plans deliberately.** Most real client engagements blend one consultancy framework (e.g., McKinsey Rewired) + one or two vendor reference architectures (e.g., Microsoft CAF + Databricks Mosaic AI) + the industry blueprint for the sector + 2–3 case-study analogues.
- **Verify before quoting.** Numeric claims (savings %, adoption %, KPIs) are flagged with their source URL; re-confirm those URLs render and read as cited before they appear in a client deck.
