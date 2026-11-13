import pytest

from shop.quantity import QuantityError, parse_quantity


def test_parses_a_number():
    assert parse_quantity(" 3 ") == 3


def test_rejects_text():
    with pytest.raises(QuantityError):
        parse_quantity("three")
