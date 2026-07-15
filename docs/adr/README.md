# Architecture Decision Records

Decisions that shape the platform, with the evidence that led to them.
Format: context → decision → consequences. Superseded ADRs stay in place,
marked as such — the history is the point.

| ADR                                                     | Title                                                             | Status   |
| ------------------------------------------------------- | ----------------------------------------------------------------- | -------- |
| [0001](0001-zero-stored-user-tokens.md)                 | Zero stored user tokens — authorization via installation token    | accepted |
| [0002](0002-multi-tenant-cell-architecture.md)          | Multi-tenant SaaS: cell per tenant + thin control plane           | accepted |
| [0003](0003-module-architecture-and-shared-packages.md) | Module architecture: hexagonal backends, shared packages          | accepted |
| [0004](0004-open-source-split.md)                       | Open-source split: public platform monorepo, private SaaS overlay | accepted |

Operational: the SaaS activation runbook lives with the control plane (`apps/control-plane/docs/saas-activation.md`) — turning ADR 0002 from code-complete into a running SaaS.
