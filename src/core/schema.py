from dataclasses import dataclass, asdict
from typing import Optional, Dict, Any

@dataclass
class Job:
    title: str
    company: str
    location: str
    url: str
    description: str
    source: str
    remote: Optional[bool] = None
    created_at: Optional[str] = None
    extras: Optional[Dict[str, Any]] = None

    def to_dict(self):
        return asdict(self)
