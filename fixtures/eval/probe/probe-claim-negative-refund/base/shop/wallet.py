class Wallet:
    """The store credit of each customer, in cents."""

    def __init__(self):
        self._balance = {}

    def credit(self, customer: str, cents: int) -> None:
        self._balance[customer] = self._balance.get(customer, 0) + cents

    def balance(self, customer: str) -> int:
        return self._balance.get(customer, 0)
