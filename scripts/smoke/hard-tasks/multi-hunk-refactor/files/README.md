# billing

A small billing service. Run the tests with
`python3 -m unittest discover -s tests -t .`.

Every state change records an audit event (`billing.audit`). An event is a
dict with `kind`, `request_id`, `actor` and the event's own fields.

`billing.api.handle(request)` is the entry point. A request is a dict with
`id`, `user`, `action` and the action's arguments. A `batch` request carries
`requests`, a list of sub-requests; each sub-request has its own `id` and
`action` and acts as the batch's `user`. After its sub-requests a batch
records a `batch.done` event of its own.

Today the request id and actor come from module-level globals in
`billing/legacy_audit.py` that `api.handle` sets and clears around each
request.
