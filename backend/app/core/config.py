from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

from pydantic import BaseModel, Field, ValidationError, constr, conlist
from urllib.parse import urlparse, urlunparse


class OllamaConfig(BaseModel):
    base_url: str = Field(..., description="Base URL for the Ollama service")
    discover_models: bool = Field(True, description="Whether to discover models dynamically")
    prepull: List[str] = Field(default_factory=list, description="Optional list of models to pre-pull")
    request_timeout_seconds: float = Field(
        120,
        ge=1,
        description="Timeout in seconds for Ollama HTTP requests",
    )


class ModelsConfig(BaseModel):
    default_model: str
    allow_user_switch_per_conversation: bool = True
    ollama: OllamaConfig
    thinking_models_allowed: bool = True


class MCPServerConfig(BaseModel):
    name: constr(strip_whitespace=True, min_length=1)
    transport: constr(strip_whitespace=True, min_length=1)
    command: Optional[str] = None
    args: Optional[List[str]] = None
    base_url: Optional[str] = None
    requires_api_key: bool = False
    enabled_by_default: bool = False
    auth_key_name: Optional[str] = None

    def transport_display(self) -> str:
        return self.transport.replace("_", "-")


class MCPConfig(BaseModel):
    servers: List[MCPServerConfig] = Field(default_factory=list)


class RagSQLiteConfig(BaseModel):
    db_path: str = Field(..., description="Relative path to the SQLite database")
    vector_extension: str = Field(..., description="Name of the SQLite vector extension to load")


class RagConfig(BaseModel):
    embedding_model: str
    chunk_size_tokens: int = Field(1000, ge=100)
    chunk_overlap_tokens: int = Field(200, ge=0)
    top_k: int = Field(5, ge=1)
    sqlite: RagSQLiteConfig


class PersonaConfig(BaseModel):
    id: constr(strip_whitespace=True, min_length=1)
    name: str
    system_prompt: str
    default_model_id: Optional[str] = None
    enabled_mcp_servers: Optional[List[str]] = None
    rag_enabled: Optional[bool] = None
    streaming_enabled: Optional[bool] = None
    preset_prompts: Optional[
        conlist(constr(strip_whitespace=True, min_length=1), max_length=4)
    ] = Field(
        default=None,
        description="Optional quick prompts available in the UI for this persona",
    )


class PersonasConfig(BaseModel):
    default_persona_id: str
    personas: List[PersonaConfig]

    def get_default(self) -> PersonaConfig:
        persona = self.find(self.default_persona_id)
        if persona is not None:
            return persona
        raise ValueError(f"Default persona '{self.default_persona_id}' not found in personas list")

    def find(self, persona_id: Optional[str]) -> Optional[PersonaConfig]:
        if persona_id is None:
            return None
        for persona in self.personas:
            if persona.id == persona_id:
                return persona
        return None

    def resolve(self, persona_id: Optional[str]) -> PersonaConfig:
        persona = self.find(persona_id)
        if persona is not None:
            return persona
        return self.get_default()


class SecretsConfig(BaseModel):
    jwt_secret: constr(min_length=16)
    api_keys: Dict[str, str] = Field(default_factory=dict)


class AppConfig(BaseModel):
    models: ModelsConfig
    mcp: MCPConfig
    rag: RagConfig
    personas: PersonasConfig
    secrets: SecretsConfig

    @property
    def safe_payload(self) -> Dict[str, object]:
        """Return a version of the configuration safe to expose to clients."""
        return {
            "models": self.models.model_dump(),
            "mcp": {"servers": [server.model_dump(exclude={"command", "args"}) for server in self.mcp.servers]},
            "rag": self.rag.model_dump(),
            "personas": self.personas.model_dump(),
        }


@dataclass
class ConfigSet:
    models: ModelsConfig
    mcp: MCPConfig
    rag: RagConfig
    personas: PersonasConfig
    secrets: SecretsConfig

    @property
    def app_config(self) -> AppConfig:
        return AppConfig(
            models=self.models,
            mcp=self.mcp,
            rag=self.rag,
            personas=self.personas,
            secrets=self.secrets,
        )


class ConfigLoaderError(RuntimeError):
    pass


def _read_json(path: Path) -> dict:
    if not path.exists():
        raise ConfigLoaderError(f"Configuration file not found: {path}")
    try:
        return json.loads(path.read_text("utf-8"))
    except json.JSONDecodeError as exc:
        raise ConfigLoaderError(f"Invalid JSON in {path}: {exc}") from exc


def _apply_env_overrides(models: ModelsConfig) -> None:
    """Apply environment variable overrides to the models configuration."""
    base_url_override = os.getenv("OLLAMA_BASE_URL")
    if base_url_override:
        models.ollama.base_url = base_url_override
        return

    ip_override = os.getenv("OLLAMA_IP")
    if not ip_override:
        return

    parsed = urlparse(models.ollama.base_url)
    scheme = parsed.scheme or "http"
    base_host = ip_override.strip()

    # If the override already includes a port, use it as-is; otherwise preserve the original port.
    if ":" in base_host:
        netloc = base_host
    else:
        port = parsed.port
        netloc = f"{base_host}:{port}" if port else base_host

    rebuilt = urlunparse(
        (
            scheme,
            netloc,
            parsed.path or "",
            parsed.params or "",
            parsed.query or "",
            parsed.fragment or "",
        )
    )
    models.ollama.base_url = rebuilt


def load_config_set(config_dir: Path) -> ConfigSet:
    """Load all required configuration files from the provided directory."""
    try:
        models = ModelsConfig(**_read_json(config_dir / "models.json"))
        _apply_env_overrides(models)
        mcp = MCPConfig(**_read_json(config_dir / "mcp.json"))
        rag = RagConfig(**_read_json(config_dir / "rag.json"))
        personas = PersonasConfig(**_read_json(config_dir / "personas.json"))
        secrets = SecretsConfig(**_read_json(config_dir / "secrets.json"))
    except ValidationError as exc:
        raise ConfigLoaderError(str(exc)) from exc

    return ConfigSet(
        models=models,
        mcp=mcp,
        rag=rag,
        personas=personas,
        secrets=secrets,
    )


def load_app_config(config_dir: Path) -> AppConfig:
    return load_config_set(config_dir).app_config
