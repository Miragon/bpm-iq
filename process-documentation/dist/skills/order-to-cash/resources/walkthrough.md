# Order to Cash — Walkthrough

Generated from `process.bpmn` and `subprocesses/invoice-handling.bpmn` at export time
(2026-07-06, process v1.0.0). Lane names in the model equal team labels in the source
team topology, so lanes are read as the responsible teams throughout.

## 1. Happy path

1. **Order received** — *Order Management* — start event. A customer places an order;
   the process starts.
2. **Validate order** — *Order Management* — human task (user task). The order is
   checked before any commitment is made.
3. **Check credit limit** — *Order Management* — automated task (service task). The
   customer's credit is checked without manual intervention; the rules it evaluates
   are the decision table `decisions/credit-check.dmn` (internal credit policy CP-7).
4. **Credit approved?** — *Order Management* — decision point (exclusive gateway).
   On the happy path the answer is **yes** (see section 2 for the alternative).
5. **Fulfill order** — *Order Management* — human task (user task). The order is
   picked, packed, and shipped.
6. **Invoice Handling** — *Payments & Billing Platform* — call activity invoking the
   `invoice-handling` sub-process (`subprocesses/invoice-handling.bpmn`):
   1. **Invoice requested** — start event.
   2. **Create invoice** — human task (user task).
   3. **Send invoice to customer** — message task (send task).
   4. **Await payment** — message task (receive task); waits for the customer's payment.
   5. **Payment recorded** — end event; the sub-process completes.
7. **Order fulfilled** — *Payments & Billing Platform* — end event. The process ends
   once payment is recorded, not when the parcel ships.

## 2. Decision points

- **Credit approved?** (exclusive gateway, after *Check credit limit*)
  - **yes** → *Fulfill order* — the order proceeds to fulfillment and invoicing.
  - **no** → *Notify customer of rejection* (send task, *Order Management*) → end event
    **Order rejected**.
  - The answer is produced by the DMN decision table `decisions/credit-check.dmn`
    (hit policy FIRST): approved when the projected exposure (open exposure + order
    amount) stays within the credit limit, or — for small orders under 500 EUR — up
    to 10% over the limit; otherwise rejected by default (credit policy CP-7).

This is the only decision point in the model.

## 3. Exceptions & loops

- **Credit check fails** (modeled as the gateway's **no** branch; ~4% of orders as of
  2026-06): the order is rejected; the customer is notified with the reason and
  alternatives (prepayment). The process ends in the distinct outcome **Order rejected**.
- **Payment not received within terms** (modeled in the *Invoice Handling*
  sub-process; ~11% of invoices as of 2026-06): a timer boundary event **Payment
  terms expired** on *Await payment* triggers **Send payment reminder** (send task),
  which loops back to *Await payment*. The reminder loop repeats until payment is
  recorded. No escalation path beyond repeated reminders is modeled — treat that as
  a fact of the model, not an omission of this walkthrough.

## 4. Handoffs

- **Fulfill order → Invoice Handling**: the single lane transition in the model, from
  the **Order Management** lane (team *Order Management*, stream-aligned) to the
  **Payments & Billing Platform** lane (team *Payments & Billing Platform*, platform
  team). Interaction mode: **x-as-a-service** — Order Management consumes the
  platform's "invoicing & payments API" as a service. Both lane names equal the team
  labels in the source team topology; no lane-to-team mapping divergence exists.
- The process ends (**Order fulfilled**) inside the *Payments & Billing Platform*
  lane; there is no modeled handoff back to *Order Management* after payment.
