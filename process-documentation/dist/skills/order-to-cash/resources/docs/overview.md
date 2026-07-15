# Order to Cash — Overview

> Level-4 narrative documentation. The model of record is [`process.bpmn`](../process.bpmn);
> facts about ownership, KPIs, and dependencies live in [`context.yaml`](../context.yaml).
> If this document and the model disagree, the model wins — and one of them needs fixing.

## Summary

Order to Cash turns a confirmed customer order into collected revenue. It is Acme Commerce's
primary revenue process, owned by the **Order Management** team, with invoicing and payment
processing consumed as a service from the **Payments & Billing Platform** team.

## Walkthrough (happy path)

1. **Order received** — a customer places an order (webshop, e-mail, or EDI).
2. **Validate order** — Order Management checks completeness: items, quantities, delivery
   address, agreed prices. Incomplete orders are clarified with the customer before proceeding.
3. **Check credit limit** — automated check against the ERP. New customers without credit terms
   must first pass through the *Customer Onboarding* process (upstream dependency).
4. **Credit approved?** — decision point.
5. **Fulfill order** — pick, pack, and ship; the ERP reserves stock at validation time.
6. **Invoice Handling** (sub-process, run by the Payments & Billing Platform team) — create and
   send the invoice, then await payment; a timer triggers reminders when payment terms expire.
   See [`subprocesses/invoice-handling.bpmn`](../subprocesses/invoice-handling.bpmn). The parent
   process ends as **Order fulfilled** once the sub-process records the payment — the process
   ends when revenue is collected, not when the parcel ships. That is deliberate: the KPI
   *order cycle time* measures order-to-payment.

## Exceptions

- **Credit check fails** → the customer is notified with the reason and offered prepayment;
  the order ends as *Order rejected*.
- **Payment not received within terms** → a timer boundary event on *Await payment* triggers a
  reminder; the loop repeats until payment is recorded. Escalation to collections is currently
  *not modeled* — known gap.

## Improvement backlog

- Credit check is custom-built in-house although credit-scoring products are available — the
  Wardley map marks the component `(buy)`; the `strategy-alignment` skill surfaces it as an
  open sourcing decision.
- Payment reminders are manual; the Payments platform roadmap includes automated dunning.
