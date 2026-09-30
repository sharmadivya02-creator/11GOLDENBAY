"""GoldenBay Presidio service — a thin wrapper around the open-source Presidio analyzer.

POST /analyze  {"text": "...", "language": "en"}  ->  [{entity_type, start, end, score}, ...]
GET  /health   ->  "ok"

It keeps nothing: text comes in, positions go out, nothing is stored or logged.
If PRESIDIO_KEY is set, requests must send the same value in the x-api-key header.
Uses the SMALL English model (en_core_web_sm) so it fits in a small free server;
the small model finds names less reliably than the large one.
"""
import hmac
import os

from flask import Flask, jsonify, request
from presidio_analyzer import AnalyzerEngine
from presidio_analyzer.nlp_engine import NlpEngineProvider

nlp = NlpEngineProvider(nlp_configuration={
    "nlp_engine_name": "spacy",
    "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}],
}).create_engine()
analyzer = AnalyzerEngine(nlp_engine=nlp, supported_languages=["en"])

app = Flask(__name__)
KEY = os.environ.get("PRESIDIO_KEY", "")


def allowed():
    if not KEY:
        return True
    return hmac.compare_digest(request.headers.get("x-api-key", ""), KEY)


@app.get("/health")
def health():
    return "ok"


@app.post("/analyze")
def analyze():
    if not allowed():
        return jsonify({"error": "unauthorized"}), 401
    body = request.get_json(silent=True) or {}
    text = str(body.get("text", ""))[:5000]
    if not text:
        return jsonify([])
    results = analyzer.analyze(text=text, language="en")
    return jsonify([
        {"entity_type": r.entity_type, "start": r.start, "end": r.end, "score": round(float(r.score), 3)}
        for r in results
    ])
