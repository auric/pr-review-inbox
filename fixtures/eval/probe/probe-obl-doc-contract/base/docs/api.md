# Catalog API

## findSku(items, sku)

Returns the item with that SKU. When two items share a SKU, the last one wins.

It returns `null` when no item matches.

## Item

An item has `sku`, `name`, and `priceCents`.
