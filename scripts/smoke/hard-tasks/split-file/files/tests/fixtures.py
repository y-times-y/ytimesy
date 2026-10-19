ITEMS_JSON = """
{
  "items": [
    {"sku": "BOLT", "name": "Bolt M6", "reorder_level": 100, "tags": ["hardware"]},
    {"sku": "FLOUR", "name": "Flour", "unit": "kg", "reorder_level": 5},
    {"sku": "OIL", "name": "Olive oil", "unit": "l"},
    {"sku": "EGG", "name": "Eggs", "reorder_level": 24}
  ],
  "locations": [
    {"code": "A1", "name": "Aisle 1", "capacity": 1000},
    {"code": "B2", "name": "Back room"}
  ]
}
"""

LOTS_CSV = """sku,location,quantity,unit,unit_cost,received
BOLT,A1,60,each,0.10,2026-01-05
BOLT,A1,40,each,0.12,2026-03-01
BOLT,B2,50,each,0.11,2026-02-10
FLOUR,B2,2500,g,1.20,2026-02-20
FLOUR,A1,1,kg,1.50,2026-03-15
OIL,B2,500,ml,8.00,2025-11-01
EGG,A1,2,dozen,0.25,2026-03-28
"""
