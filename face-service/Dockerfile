FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DEEPFACE_HOME=/root/.deepface \
    TF_CPP_MIN_LOG_LEVEL=2

RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY face-service/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download ArcFace + RetinaFace weights (~240MB) into the image so the
# first /recognize after a cold-start doesn't stall on a 30s download.
RUN python -c "import numpy as np; from deepface import DeepFace; \
    DeepFace.build_model('ArcFace'); \
    DeepFace.represent(np.zeros((224,224,3),dtype=np.uint8), \
                       model_name='ArcFace', detector_backend='retinaface', \
                       enforce_detection=False, align=False)"

COPY server/scripts/face_service.py /app/server/scripts/face_service.py
COPY server/kb/characters/face_gallery.json /app/server/kb/characters/face_gallery.json

EXPOSE 5001

CMD ["python", "/app/server/scripts/face_service.py", "--host", "0.0.0.0", "--port", "5001"]
