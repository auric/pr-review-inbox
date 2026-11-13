from dataclasses import dataclass


@dataclass(frozen=True)
class Event:
    kind: str
    payload: dict
