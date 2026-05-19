#!/usr/bin/env python3
"""T2.2 + T2.3 + T2.5 — Curated starter set for idea_models, idea_datasets, plan_*.

Strategy (intentionally coarse for v1 — easy to refine entry-by-entry later):

  * idea_models / idea_datasets:
      Maintain a TASK_TO_MODELS / TASK_TO_DATASETS map of well-known HF IDs
      per task slug. For each idea, propagate suggestions from the tasks it's
      linked to (idea_tasks). This means every idea tagged 'text-generation'
      gets the same 3 starter LLM suggestions — coarse but useful, and
      trivially overridable per-idea later.

  * plan_ideas:
      Use the same tag-overlap-score logic the UI already uses
      (TAG_WEIGHTS for industry/function/value/tech/audience/maturity).
      Each plan links to the top-K ideas above a threshold.

  * plan_models / plan_datasets:
      Derived: union of idea_models / idea_datasets for the plan's linked
      ideas, limited to those appearing in N+ ideas (consensus filter).

All writes are ADDITIVE to data/links.json — existing manual curation in
these arrays is preserved (we only add new uuids, never remove).
"""
from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PLANS_DIR = ROOT / "plans"
LINKS_PATH = DATA / "links.json"

# Per-task starter HF model IDs — popular, well-licensed, instruction-tuned where applicable.
TASK_TO_MODELS: dict[str, list[str]] = {
    "text-generation": [
        "meta-llama/Llama-3.1-8B-Instruct",
        "mistralai/Mistral-7B-Instruct-v0.3",
        "Qwen/Qwen2.5-7B-Instruct",
    ],
    "automatic-speech-recognition": [
        "openai/whisper-large-v3",
        "openai/whisper-base",
        "nvidia/parakeet-tdt-0.6b-v2",
    ],
    "text-to-speech": [
        "suno/bark",
        "coqui/XTTS-v2",
    ],
    "voice-activity-detection": [
        "pyannote/voice-activity-detection",
    ],
    "translation": [
        "Helsinki-NLP/opus-mt-en-es",
        "facebook/nllb-200-distilled-600M",
        "meta-llama/Llama-3.1-8B-Instruct",
    ],
    "summarization": [
        "facebook/bart-large-cnn",
        "google/pegasus-xsum",
    ],
    "feature-extraction": [
        "sentence-transformers/all-MiniLM-L6-v2",
        "BAAI/bge-large-en-v1.5",
        "intfloat/e5-large-v2",
    ],
    "text-classification": [
        "distilbert/distilbert-base-uncased-finetuned-sst-2-english",
        "cardiffnlp/twitter-roberta-base-sentiment-latest",
    ],
    "token-classification": [
        "dslim/bert-base-NER",
        "Davlan/xlm-roberta-large-ner-hrl",
    ],
    "zero-shot-classification": [
        "facebook/bart-large-mnli",
    ],
    "question-answering": [
        "deepset/roberta-base-squad2",
        "meta-llama/Llama-3.1-8B-Instruct",
    ],
    "text-to-image": [
        "stabilityai/stable-diffusion-3-medium-diffusers",
        "black-forest-labs/FLUX.1-schnell",
        "stabilityai/stable-diffusion-xl-base-1.0",
    ],
    "image-to-image": [
        "stabilityai/stable-diffusion-xl-refiner-1.0",
    ],
    "image-classification": [
        "google/vit-base-patch16-224",
        "microsoft/resnet-50",
    ],
    "object-detection": [
        "facebook/detr-resnet-50",
        "hustvl/yolos-small",
    ],
    "image-segmentation": [
        "nvidia/segformer-b0-finetuned-ade-512-512",
        "facebook/sam-vit-base",
    ],
    "image-to-text": [
        "Salesforce/blip-image-captioning-large",
        "microsoft/git-large",
    ],
    "depth-estimation": [
        "Intel/dpt-large",
        "depth-anything/Depth-Anything-V2-Large",
    ],
    "text-to-video": [
        "ali-vilab/text-to-video-ms-1.7b",
    ],
    "image-text-to-text": [
        "meta-llama/Llama-3.2-11B-Vision-Instruct",
        "Qwen/Qwen2-VL-7B-Instruct",
    ],
    "document-question-answering": [
        "impira/layoutlm-document-qa",
    ],
    "visual-question-answering": [
        "Salesforce/blip-vqa-base",
    ],
    "tabular-classification": [
        "autogluon/tabpfn-mix-1.0-classifier",
    ],
    "tabular-regression": [
        "autogluon/tabpfn-mix-1.0-regressor",
    ],
    "time-series-forecasting": [
        "amazon/chronos-t5-large",
        "google/timesfm-1.0-200m",
    ],
    "text-retrieval": [
        "intfloat/e5-large-v2",
        "BAAI/bge-large-en-v1.5",
    ],
    "text-ranking": [
        "cross-encoder/ms-marco-MiniLM-L6-v2",
    ],
    "robotics": [
        "lerobot/pi0",
        "physical-intelligence/pi0",
    ],
}

# Per-task starter HF dataset IDs.
TASK_TO_DATASETS: dict[str, list[str]] = {
    "text-generation": [
        "HuggingFaceH4/ultrachat_200k",
        "tatsu-lab/alpaca",
    ],
    "automatic-speech-recognition": [
        "mozilla-foundation/common_voice_17_0",
        "openslr/librispeech_asr",
    ],
    "text-to-speech": [
        "amphion/Emilia-Dataset",
    ],
    "translation": [
        "facebook/flores",
        "opus_books",
    ],
    "summarization": [
        "EdinburghNLP/xsum",
        "cnn_dailymail",
    ],
    "feature-extraction": [
        "mteb/banking77",
        "HuggingFaceFW/fineweb",
    ],
    "text-classification": [
        "stanfordnlp/sst2",
        "fancyzhx/ag_news",
    ],
    "token-classification": [
        "tner/ontonotes5",
        "eriktks/conll2003",
    ],
    "question-answering": [
        "rajpurkar/squad_v2",
        "google/natural_questions",
    ],
    "text-to-image": [
        "laion/laion-coco",
        "lambdalabs/pokemon-blip-captions",
    ],
    "image-classification": [
        "ILSVRC/imagenet-1k",
        "cifar10",
    ],
    "object-detection": [
        "detection-datasets/coco",
    ],
    "image-segmentation": [
        "scene_parse_150",
    ],
    "image-to-text": [
        "ydshieh/coco_dataset_script",
    ],
    "text-retrieval": [
        "BeIR/msmarco",
        "mteb/scifact",
    ],
    "text-ranking": [
        "BeIR/msmarco",
    ],
    "tabular-classification": [
        "scikit-learn/credit-card-fraud-detection",
    ],
    "tabular-regression": [
        "scikit-learn/auto-mpg",
    ],
    "time-series-forecasting": [
        "Salesforce/lotsa_data",
    ],
    "robotics": [
        "lerobot/aloha_static_battery",
    ],
}

TAG_WEIGHTS = {
    "industry": 3, "function": 2, "value": 2,
    "tech": 2, "audience": 1, "maturity": 1,
}
MIN_OVERLAP_SCORE = 4
MAX_IDEAS_PER_PLAN = 8
PLAN_MODEL_CONSENSUS = 2     # only link a model to a plan if ≥2 of the plan's ideas suggest it


def parse_frontmatter(text: str) -> dict:
    m = re.match(r"^---\n([\s\S]*?)\n---\n?", text)
    if not m:
        return {}
    out = {}
    for line in m.group(1).split("\n"):
        line = line.strip()
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        k, v = k.strip(), v.strip()
        if v.startswith("[") and v.endswith("]"):
            v = [x.strip() for x in v[1:-1].split(",") if x.strip()]
        out[k] = v
    return out


def main() -> int:
    import sqlite3
    db = sqlite3.connect(ROOT / "public" / "catalog.sqlite")

    # task slug → uuid
    slug_to_uuid = {row[0]: row[1] for row in db.execute("SELECT slug, uuid FROM tasks")}

    # idea uuid → set of task uuids
    idea_tasks: dict[str, set[str]] = defaultdict(set)
    for iuid, tuid in db.execute("SELECT idea_uuid, task_uuid FROM idea_tasks"):
        idea_tasks[iuid].add(tuid)

    # idea uuid → set of tag full strings (e.g., "industry/retail")
    idea_tag_set: dict[str, set[tuple[str, str]]] = defaultdict(set)
    for iuid, facet, value in db.execute("SELECT idea_uuid, facet, value FROM idea_tags"):
        idea_tag_set[iuid].add((facet, value))

    # plan slug → uuid (need data/plans.json)
    plans_path = DATA / "plans.json"
    if not plans_path.exists():
        print("FAIL: data/plans.json missing — run scripts/build_plans_registry.py first")
        return 1
    plans = json.loads(plans_path.read_text())

    # plan uuid → tag set (parsed from plan markdown frontmatter)
    plan_tag_set: dict[str, set[tuple[str, str]]] = {}
    for p in plans:
        path = PLANS_DIR / p["file"]
        if not path.exists():
            continue
        fm = parse_frontmatter(path.read_text())
        tags = fm.get("tags") if isinstance(fm.get("tags"), list) else []
        tag_pairs = set()
        for t in tags:
            if "/" in t:
                facet, value = t.split("/", 1)
                tag_pairs.add((facet.strip(), value.strip()))
        plan_tag_set[p["uuid"]] = tag_pairs

    # ───────── idea_models / idea_datasets via task propagation ─────────

    new_idea_models: dict[str, set[str]] = defaultdict(set)
    new_idea_datasets: dict[str, set[str]] = defaultdict(set)

    task_uuid_to_slug = {v: k for k, v in slug_to_uuid.items()}
    for idea_uuid, task_uuids in idea_tasks.items():
        for tuid in task_uuids:
            tslug = task_uuid_to_slug.get(tuid)
            if not tslug:
                continue
            for mid in TASK_TO_MODELS.get(tslug, []):
                new_idea_models[idea_uuid].add(mid)
            for did in TASK_TO_DATASETS.get(tslug, []):
                new_idea_datasets[idea_uuid].add(did)

    # ───────── plan_ideas via tag-overlap score ─────────

    plan_ideas: dict[str, list[str]] = {}
    for plan_uuid, plan_tags in plan_tag_set.items():
        if not plan_tags:
            continue
        scores = []
        for idea_uuid, idea_tags in idea_tag_set.items():
            overlap = plan_tags & idea_tags
            if not overlap:
                continue
            score = sum(TAG_WEIGHTS.get(f, 1) for f, _ in overlap)
            if score >= MIN_OVERLAP_SCORE:
                scores.append((score, idea_uuid))
        scores.sort(reverse=True)
        plan_ideas[plan_uuid] = [u for _, u in scores[:MAX_IDEAS_PER_PLAN]]

    # ───────── plan_models / plan_datasets — derived from plan_ideas ─────────

    plan_models: dict[str, set[str]] = defaultdict(set)
    plan_datasets: dict[str, set[str]] = defaultdict(set)
    for plan_uuid, idea_uuids in plan_ideas.items():
        model_counter: Counter[str] = Counter()
        dataset_counter: Counter[str] = Counter()
        for iuid in idea_uuids:
            for mid in new_idea_models.get(iuid, set()):
                model_counter[mid] += 1
            for did in new_idea_datasets.get(iuid, set()):
                dataset_counter[did] += 1
        for mid, n in model_counter.items():
            if n >= PLAN_MODEL_CONSENSUS:
                plan_models[plan_uuid].add(mid)
        for did, n in dataset_counter.items():
            if n >= PLAN_MODEL_CONSENSUS:
                plan_datasets[plan_uuid].add(did)

    # ───────── Merge into links.json (additive) ─────────

    links = json.loads(LINKS_PATH.read_text())

    def merge_string_links(key: str, mapping: dict[str, set[str]], field: str):
        existing_rows = links.get(key, [])
        existing_map = {r["idea"] if "idea" in r else r["plan"]: set(r.get(field, []))
                        for r in existing_rows}
        for k, vals in mapping.items():
            existing_map.setdefault(k, set()).update(vals)
        id_key = "plan" if key.startswith("plan_") else "idea"
        merged = [{id_key: k, field: sorted(v)} for k, v in sorted(existing_map.items()) if v]
        links[key] = merged

    def merge_uuid_links(key: str, mapping: dict[str, list[str] | set[str]], field: str):
        existing_rows = links.get(key, [])
        existing_map = {r["plan"]: set(r.get(field, [])) for r in existing_rows}
        for k, vals in mapping.items():
            existing_map.setdefault(k, set()).update(vals)
        merged = [{"plan": k, field: sorted(v)} for k, v in sorted(existing_map.items()) if v]
        links[key] = merged

    merge_string_links("idea_models",   new_idea_models,   "model_ids")
    merge_string_links("idea_datasets", new_idea_datasets, "dataset_ids")
    merge_uuid_links  ("plan_ideas",    plan_ideas,        "ideas")
    merge_string_links("plan_models",   plan_models,       "model_ids")
    merge_string_links("plan_datasets", plan_datasets,     "dataset_ids")

    LINKS_PATH.write_text(json.dumps(links, indent=2, ensure_ascii=False) + "\n")

    # Report
    print(f"Wrote {LINKS_PATH}")
    print()
    print(f"  idea_models rows:    {sum(1 for v in new_idea_models.values() if v)} (avg {sum(len(v) for v in new_idea_models.values()) / max(1, sum(1 for v in new_idea_models.values() if v)):.1f} models/idea)")
    print(f"  idea_datasets rows:  {sum(1 for v in new_idea_datasets.values() if v)}")
    print(f"  plan_ideas rows:     {sum(1 for v in plan_ideas.values() if v)} (avg {sum(len(v) for v in plan_ideas.values()) / max(1, sum(1 for v in plan_ideas.values() if v)):.1f} ideas/plan)")
    print(f"  plan_models rows:    {sum(1 for v in plan_models.values() if v)}")
    print(f"  plan_datasets rows:  {sum(1 for v in plan_datasets.values() if v)}")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
