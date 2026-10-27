"""Private local prediction API. It never reads project data/ or trains models."""
import hmac
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request, Security
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.security import APIKeyHeader

from .model import AnomalyModel, load_model, model_directory
from .schema import PredictionRequest

MAX_REQUEST_BYTES = 64 * 1024


class RequestBoundary:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers", []))
        if b"origin" in headers:
            return await JSONResponse({"error": "Browser access is forbidden"}, status_code=403)(scope, receive, send)
        try:
            length = int(headers.get(b"content-length", b"0"))
            if length < 0:
                raise ValueError()
        except ValueError:
            return await JSONResponse({"error": "Invalid request"}, status_code=400)(scope, receive, send)
        if length > MAX_REQUEST_BYTES:
            return await JSONResponse({"error": "Request too large"}, status_code=413)(scope, receive, send)
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > MAX_REQUEST_BYTES:
                return await JSONResponse({"error": "Request too large"}, status_code=413)(scope, receive, send)
            if not message.get("more_body", False):
                break

        delivered = False

        async def replay():
            nonlocal delivered
            if delivered:
                return await receive()
            delivered = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        await self.app(scope, replay, send)


def create_app(model: AnomalyModel | None = None, service_key: str | None = None) -> FastAPI:
    key = service_key if service_key is not None else os.getenv("ML_SERVICE_KEY", "")

    @asynccontextmanager
    async def lifespan(application):
        if application.state.model is None:
            try:
                application.state.model = load_model(model_directory())
            except Exception:
                application.state.model = None
        yield

    application = FastAPI(title="EduVerify local synthetic anomaly service", lifespan=lifespan,
                          docs_url=None, redoc_url=None, openapi_url=None)
    application.state.model = model
    application.add_middleware(RequestBoundary)
    key_header = APIKeyHeader(name="X-ML-Service-Key", auto_error=False)

    def authorize(supplied: str | None = Security(key_header)) -> None:
        if len(key) < 32:
            raise HTTPException(503, "ML service key is not configured")
        if not supplied or not hmac.compare_digest(supplied.encode(), key.encode()):
            raise HTTPException(401, "Unauthorized internal request")

    def available() -> AnomalyModel:
        if application.state.model is None:
            raise HTTPException(503, "Model unavailable; run offline training")
        return application.state.model

    @application.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, error: RequestValidationError):
        return JSONResponse({"error": "Invalid feature request"}, status_code=422)

    @application.exception_handler(HTTPException)
    async def http_error(request: Request, error: HTTPException):
        return JSONResponse({"error": error.detail}, status_code=error.status_code)

    @application.exception_handler(Exception)
    async def internal_error(request: Request, error: Exception):
        return JSONResponse({"error": "ML inference failed"}, status_code=500)

    @application.middleware("http")
    async def no_cache(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @application.get("/health")
    def health():
        ready = application.state.model is not None and len(key) >= 32
        return JSONResponse({"status": "ok" if ready else "unavailable", "model_available": ready},
                            status_code=200 if ready else 503)

    @application.get("/model/info", dependencies=[Depends(authorize)])
    def info():
        return available().metadata

    @application.post("/predict", dependencies=[Depends(authorize)])
    def predict(body: PredictionRequest):
        return available().predict(body.records)

    return application


app = create_app()
