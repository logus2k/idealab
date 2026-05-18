---
title: Databricks Data Intelligence Platform + Mosaic AI
type: vendor-architecture
source: Databricks
source_url: https://www.databricks.com/product/data-intelligence-platform
date: 2026-01
industries: [cross-industry, financial-services, healthcare, retail, manufacturing]
maturity: pattern
verification: training-knowledge-cutoff-2026-01
tags: [function/cio, function/enterprise-tech, function/data-analytics, industry/cross-industry, tech/genai, tech/agentic, tech/llm, tech/rag, tech/fine-tuning, tech/vector-search, audience/employee-facing, value/productivity, value/cost-reduction, value/decision-support, maturity/pattern]
---

# Databricks Data Intelligence Platform + Mosaic AI

> **Verification note:** Reconstructed from canonical Databricks material within January 2026 knowledge cutoff; URLs are canonical vendor pages but should be re-confirmed before client delivery.

## 1. Executive Snapshot
Databricks' adoption pattern centers on the **Data Intelligence Platform** — a Lakehouse (Delta Lake + Unity Catalog) extended with **Mosaic AI** for end-to-end GenAI development, plus the **Big Book of Generative AI** as the prescriptive playbook covering compound AI systems, RAG, fine-tuning, agents, and evaluation. The pitch: AI is only as good as your data, and Databricks unifies them in one governed plane.

## 2. Context & Strategic Drivers
Databricks argues off-the-shelf foundation models are not the moat — your enterprise data is. "AI-ready Lakehouse" means data is governed, retrievable, and AI-accessible by default. The acquisition of MosaicML ($1.3B, 2023) and the launch of DBRX positioned Databricks as a full-stack alternative for customers who want to own their models on their data.

## 3. Objectives & Target Outcomes
- Unify the data and AI lifecycle on a single governed Lakehouse.
- Move enterprises from "GenAI experimentation" to production compound AI systems with measurable accuracy on internal data.
- Govern every data asset, model, vector index, and agent in **Unity Catalog**.
- Reduce inference and training cost via **Mosaic AI Model Training** and the **Mosaic AI Gateway**.

## 4. Adoption Roadmap / Phases
The Big Book of GenAI prescribes a compound-AI-system progression:
1. **Prompt engineering** with off-the-shelf foundation models.
2. **RAG** over governed enterprise data (Vector Search + Unity Catalog).
3. **Fine-tuning / continued pretraining** for domain adaptation.
4. **Compound AI / Agent systems** chaining tools, retrievers, models.
5. **Evaluation, monitoring, and governance** in production with Lakehouse Monitoring and Mosaic AI Agent Evaluation.

## 5. Training & Workforce Enablement
**Databricks Academy** with role-based learning paths; certifications: **Databricks Certified Generative AI Engineer Associate**, **Machine Learning Associate / Professional**, **Data Engineer Associate / Professional**, **Data Analyst Associate**. Partner network: Accenture, Capgemini, Deloitte, Tata Consultancy, Infosys, Lovelytics, Onix.

## 6. Product Ideation & Development
- **Mosaic AI Foundation Model APIs:** pay-per-token serving of DBRX, Llama, Mistral, Claude (via partner), plus per-workload provisioned throughput.
- **Mosaic AI Model Training:** fine-tuning and continued pretraining as a service.
- **Mosaic AI Agent Framework + Agent Evaluation:** SDK for building agents (LangGraph / LangChain-compatible) and an LLM-judge evaluation harness.
- **Mosaic AI Vector Search:** managed vector DB with Delta sync.
- **Mosaic AI Gateway:** unified governance / observability / rate limiting across external + internal model endpoints.
- **AI/BI Genie + Databricks Assistant:** NL data analyst on the Lakehouse.

## 7. Cost Reduction Levers
**Pay-per-token + provisioned throughput** tiers; Mosaic AI Model Training pricing optimized for fine-tuning at lower TCO than DIY; **Photon** engine for retrieval; **Predictive Optimization** for Delta; serverless compute autoscaling; **Mosaic AI Gateway** consolidates external API spend with budget enforcement; smaller fine-tuned open models (Llama 3, DBRX, Mistral) often replace expensive frontier API calls.

## 8. Portfolio & Competitive Positioning
Differentiator is unification: one governance plane (Unity Catalog) for tables, files, models, functions, volumes, dashboards, and agents. Multi-cloud (AWS, Azure, GCP) and model-agnostic. Vs hyperscaler stacks, customers win on data gravity (their Lakehouse is already there) and on the ability to fine-tune open models on proprietary data without exfiltration.

## 9. Market Expansion Plays
Native deployment on AWS, Azure (Azure Databricks first-party), and GCP. Databricks Marketplace and Partner Connect for data + model sharing. Strong vertical plays in financial services, healthcare / life sciences, retail / CPG, manufacturing.

## 10. Technology & Architecture
Delta Lake (open table format with Iceberg compatibility via UniForm); Unity Catalog (multi-cloud governance); Mosaic AI (training, serving, vector search, gateway, agent framework, agent evaluation, monitoring); Lakeflow (ETL / streaming); AI/BI dashboards & Genie; Databricks Apps for low-code app hosting; Genie spaces for data Q&A.

## 11. Governance, Risk & Responsible AI
Unity Catalog as the single source of truth for permissions, lineage, audit, and data classification (extended to AI assets — models, vector indexes, feature tables, functions, agents). **AI Guardrails** in Mosaic AI Gateway (PII detection, topic moderation, safety filters). **Lakehouse Monitoring** for data + model drift. **Mosaic AI Agent Evaluation** with built-in judges for groundedness, safety, toxicity, relevance.

## 12. KPIs & Measured Outcomes
Customer-story library (`databricks.com/customers`) profiles Block (Square), Shell, Mastercard, Rivian, AT&T, Comcast. Specific KPI numbers are case-specific — pull from those pages or the annual State of Data + AI report.

## 13. Risks, Constraints & Open Questions
Cost predictability of DBU consumption can surprise customers; multi-cloud parity occasionally lags (some features Azure-first or AWS-first); Unity Catalog migration from Hive metastore remains a non-trivial project for legacy customers; Mosaic AI Vector Search is newer than dedicated vector DBs (Pinecone, Weaviate); deep DBR / runtime version dependency.

## 14. References
- [Data Intelligence Platform](https://www.databricks.com/product/data-intelligence-platform)
- [Mosaic AI](https://www.databricks.com/product/machine-learning/mosaic)
- [Generative AI docs](https://docs.databricks.com/en/generative-ai/index.html)
- [Big Book of Generative AI](https://www.databricks.com/resources/ebook/big-book-generative-ai)
- [Unity Catalog](https://www.databricks.com/product/unity-catalog)
- [Certification](https://www.databricks.com/learn/certification)
- [Customer stories](https://www.databricks.com/customers)
- [Databricks Blog](https://www.databricks.com/blog)
