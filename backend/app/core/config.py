from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

from pydantic import BaseModel, Field, ValidationError, constr


class OllamaConfig(BaseModel):
    base_url: str = Field(..., description="Base URL for the Ollama service")
    discover_models: bool = Field(True, description="Whether to discover models dynamically")
    prepull: List[str] = Field(default_factory=list, description="Optional list of models to pre-pull")


class ModelsConfig(BaseModel):
    default_model: str
    allow_user_switch_per_conversation: bool = True
    ollama: OllamaConfig
    thinking_models_allowed: bool = True


class MCPServerConfig(BaseModel):
    name: constr(strip_whitespace=True, min_length=1)
    transport: constr(strip_whitespace=True, min_length=1)
    command: Optional[str]
    args: Optional[List[str]]
    base_url: Optional[str]
    requires_api_key: bool = False
    enabled_by_default: bool = False
    auth_key_name: Optional[str]

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


class PersonasConfig(BaseModel):
    default_persona_id: str
    personas: List[PersonaConfig]

    def get_default(self) -> PersonaConfig:
        for persona in self.personas:
            if persona.id == self.default_persona_id:
                return persona
        raise ValueError(f"Default persona '{self.default_persona_id}' not found in personas list")


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
            "models": self.models.dict(),
            "mcp": {"servers": [server.dict(exclude={"command", "args"}) for server in self.mcp.servers]},
            "rag": self.rag.dict(),
            "personas": self.personas.dict(),
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


def load_config_set(config_dir: Path) -> ConfigSet:
    """Load all required configuration files from the provided directory."""
    try:
        models = ModelsConfig(**_read_json(config_dir / "models.json"))
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
