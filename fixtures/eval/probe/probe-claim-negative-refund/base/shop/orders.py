from dataclasses import dataclass, field


@dataclass
class Line:
    sku: str
    price_cents: int
    quantity: int
    refunded: int = 0


@dataclass
class Order:
    id: str
    customer: str
    lines: dict[str, Line] = field(default_factory=dict)
