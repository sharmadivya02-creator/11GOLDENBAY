FROM python:3.11-slim
WORKDIR /app
RUN pip install --no-cache-dir presidio-analyzer flask gunicorn \
 && python -m spacy download en_core_web_sm
COPY app.py .
# Render sets $PORT (default 10000). One worker keeps memory small.
CMD gunicorn --bind 0.0.0.0:${PORT:-10000} --workers 1 --threads 2 --timeout 60 app:app
