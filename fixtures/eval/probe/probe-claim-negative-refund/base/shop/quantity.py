MAX_QUANTITY = 1000


class QuantityError(ValueError):
    pass


def parse_quantity(text: str) -> int:
    """Parses a quantity from a form field."""
    try:
        value = int(text.strip())
    except ValueError as e:
        raise QuantityError(f"not a number: {text!r}") from e
    if value > MAX_QUANTITY:
        raise QuantityError(f"more than {MAX_QUANTITY}")
    return value
