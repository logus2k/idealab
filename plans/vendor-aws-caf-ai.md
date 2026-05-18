---
title: AWS CAF for AI + Well-Architected ML / GenAI Lenses
type: vendor-architecture
source: Amazon Web Services
source_url: https://docs.aws.amazon.com/whitepapers/latest/aws-caf-for-ai/aws-caf-for-ai.html
date: 2025-11-19
industries: [cross-industry]
maturity: pattern
verification: vendor-docs-fetched
tags: [function/cio, function/enterprise-tech, function/governance, industry/cross-industry, tech/genai, tech/agentic, tech/llm, audience/back-office, audience/employee-facing, value/productivity, value/cost-reduction, value/risk-reduction, maturity/pattern]
---

# AWS CAF for AI + Well-Architected ML / GenAI Lenses

## 1. Executive Snapshot
AWS layers three artifacts: (a) the **AWS Cloud Adoption Framework for AI / ML / GenAI (CAF-AI)** — six "perspectives" (Business, People, Governance, Platform, Security, Operations) mirroring the parent AWS CAF; (b) the **Well-Architected Machine Learning Lens** (Nov 2025) and **Generative AI Lens** (Nov 2025) — best-practice checklists mapped to the six Well-Architected pillars; and (c) Bedrock-centric reference architectures for foundation-model apps with Amazon Q, Bedrock, and SageMaker AI.

## 2. Context & Strategic Drivers
AWS frames AI as "an entirely new breed of technologies that has a large impact on all verticals" and CAF-AI as a vehicle to "go beyond a single proof of concept." The two new Lenses (Nov 2025) acknowledge that GenAI workloads need their own architectural guidance distinct from classical ML.

## 3. Objectives & Target Outcomes
- Mature organizations through four AI journey stages: Project → Foundation → Production → Scale.
- Make AI workloads **Well-Architected** against the six pillars adapted for ML and GenAI.
- Achieve responsible, secure, cost-optimized, sustainable AI at scale on AWS.
- Codify the shared responsibility for Responsible AI between model producers, providers, and consumers.

## 4. Adoption Roadmap / Phases
- **CAF-AI perspectives:** Business, People, Governance, Platform, Security, Operations — each enriched with AI-specific foundational capabilities.
- **Maturity stages:** Project → Foundation → Production → Scale.
- **GenAI Lens lifecycle:** Scoping → Model selection → Customization → Development → Deployment → Continuous improvement.
- **ML Lens:** Covers supervised / unsupervised, predictive analytics, classification, regression, clustering across the full ML lifecycle.

## 5. Training & Workforce Enablement
AWS Skill Builder learning plans; certifications: **AWS Certified AI Practitioner (AIF-C01)** (foundational, launched 2024), **AWS Certified Machine Learning Engineer – Associate**, **AWS Certified Machine Learning – Specialty**. People perspective adds AI literacy, RAI training, data-science talent acquisition, and AWS Partner Network ML Competency partners.

## 6. Product Ideation & Development
- **Amazon Bedrock:** managed access to 100+ FMs incl. Anthropic Claude (Opus 4.6 / 4.7), Amazon Nova, Meta Llama, Mistral, AI21, Cohere, DeepSeek, OpenAI gpt-oss; APIs: Converse, Messages, Responses, Invoke.
- **Bedrock features:** Knowledge Bases (managed RAG), Agents, Guardrails, Model Evaluation, Bedrock Studio, custom model import, distillation, provisioned throughput.
- **Amazon Q:** Q Developer (coding), Q Business (enterprise assistant), Q in QuickSight.
- **Amazon SageMaker AI / SageMaker HyperPod / SageMaker Unified Studio:** custom training, fine-tuning, MLOps.

## 7. Cost Reduction Levers
GenAI Lens explicitly calls out: choose cost-optimized models; balance inference cost / performance; engineer prompts for token cost; optimize vector stores and agent workflows; use **provisioned throughput** for steady traffic and **on-demand** for bursty; **Bedrock cost allocation by IAM principal** (added April 2026) for chargeback; SageMaker Savings Plans; Inf2 / Trainium silicon for inference cost reduction; sustainability pillar adds serverless and model-efficiency techniques.

## 8. Portfolio & Competitive Positioning
AWS positions **multi-model choice** as its differentiator: customers are not locked into one model family — Bedrock concentrates Anthropic, Amazon, Meta, Mistral, AI21, Cohere, DeepSeek, and OpenAI behind one API and one IAM / VPC perimeter. The Well-Architected Tool and custom Lenses (importable JSON from `aws-samples` GitHub) operationalize the framework as a self-assessment.

## 9. Market Expansion Plays
Global region rollout with cross-region inference; AWS Marketplace for ML / GenAI offerings; AWS Generative AI Competency partners; AWS Generative AI Innovation Center (a funded co-build program); industry-specific accelerators (FSI, healthcare, public sector).

## 10. Technology & Architecture
Bedrock + Knowledge Bases (OpenSearch / Aurora pgvector / MongoDB / Pinecone) + Agents for Bedrock; SageMaker AI (training, inference endpoints, model registry, Pipelines, Clarify, Model Monitor); EKS / ECS / Lambda for orchestration; Trainium / Inferentia silicon; Nitro Enclaves for confidential inference; PrivateLink endpoints for Bedrock; AWS Glue / S3 / Lake Formation as data foundation.

## 11. Governance, Risk & Responsible AI
**Amazon Bedrock Guardrails** (content filters, denied topics, word filters, sensitive information filters, contextual grounding checks, automated reasoning checks for hallucinations); **SageMaker Clarify** (bias detection + explainability); **SageMaker Model Monitor** (drift); Model Cards; AWS AI Service Cards (transparency artifacts); CAF-AI Governance perspective adds AI policies, model lifecycle approvals, third-party data vetting.

## 12. KPIs & Measured Outcomes
The whitepapers are vendor-agnostic and do not embed KPIs; AWS publishes customer outcomes in `aws.amazon.com/solutions/case-studies/` and re:Invent keynotes. Pull case-specific numbers (NatWest, BMW, Toyota, Pfizer, NASDAQ generative AI deployments) directly from those AWS-hosted case studies.

## 13. Risks, Constraints & Open Questions
Bedrock model availability varies by region (Claude Opus 4.7 initially gated to US East); pricing across 100+ models is heterogeneous and hard to forecast; Knowledge Bases lock-in to managed RAG patterns; Guardrails are AWS-specific and don't port to other clouds; the original CAF-AI whitepaper carries a Feb 2024 publication date with a "historical reference" banner — triangulate with the newer Nov 2025 Well-Architected Lenses for current guidance.

## 14. References
- [AWS CAF for AI whitepaper](https://docs.aws.amazon.com/whitepapers/latest/aws-caf-for-ai/aws-caf-for-ai.html) — Feb 13 2024
- [Machine Learning Lens](https://docs.aws.amazon.com/wellarchitected/latest/machine-learning-lens/machine-learning-lens.html) — Nov 19 2025
- [Generative AI Lens](https://docs.aws.amazon.com/wellarchitected/latest/generative-ai-lens/generative-ai-lens.html) — Nov 19 2025
- [Amazon Bedrock User Guide](https://docs.aws.amazon.com/bedrock/latest/userguide/what-is-bedrock.html)
- [AWS Cloud Adoption Framework](https://aws.amazon.com/cloud-adoption-framework/)
- [AWS Well-Architected](https://aws.amazon.com/architecture/well-architected/)
- [Responsible Machine Learning](https://aws.amazon.com/machine-learning/responsible-machine-learning/)
- [Well-Architected custom Lens samples](https://github.com/aws-samples/sample-well-architected-custom-lens)
