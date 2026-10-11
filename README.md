# n8n-nodes-ratifia

Pause an n8n workflow for human approval. Ratifia routes the decision to a
person, records who decided and why, and the workflow continues on their answer.

## Install

**n8n Cloud:** open the nodes panel, search for **Ratifia**, and install it.

**Self-hosted n8n:** Settings → Community Nodes → Install → `n8n-nodes-ratifia`

## Credential

An org API key from the Ratifia dashboard under **API Keys**. The key is shown
once and stored hashed, so if it is lost, rotate it rather than looking it up.

Leave **Base URL** at its default, `https://api.ratifia.com`, unless Ratifia
gives you a different endpoint.

## Operations

**Request Approval and Wait.** Ask a human and hold the workflow until they
answer. Simplest, and right for anything answered in minutes.

**Request Approval.** Ask and continue immediately with a decision ID. Pair it
with n8n's own Wait node when an answer may take hours, so the execution is not
held open.

**Verify Approval.** Check, without spending it, that an approval covers the
action you are about to take.

**Consume Approval.** Spend an approval on exactly one action, immediately
before you take it. A retry with the same **Consumer** key is reported as
already consumed, so it is safe to retry.

**Get Decision.** Read the current state of a decision.

**Cancel Decision.** Withdraw a decision nobody needs to answer any more.

**Send a Test Decision.** Send yourself a sample decision and see what a reviewer
sees. Put your address in **Send To** and run the node with Execute Step. It
creates one real decision with sample facts, a source link and an editable draft,
expires by itself after 15 minutes, and nothing acts on the verdict.

Every operation that names a decision also returns a `url`, so you can open it
in Ratifia straight from the node's output.

## Use a policy

Pick a **Policy** from the dropdown (it lists your org's policies) and the
decision inherits who approves, the quorum they must reach, and the surface the
verdict is recorded on. That keeps approver emails out of your workflow, and
means changing who signs off is a policy edit rather than a workflow edit.

An unknown policy key is refused and **no decision is created**, so a typo stops
the workflow rather than quietly sending it through without a gate.

## Check the approval where you act

An approval is for one exact action. Give **Request Approval** the **Facts**
that matter (for an email: recipient, subject, body, attachments); only a hash
is sent. Right before acting, build the same facts from what you are *about to
do* and pass them to **Verify Approval** and **Consume Approval**:

- if anything changed since approval, they return `facts_mismatch`, so don't act;
- act only when **Consume Approval** returns `consumed: true` and not
  `alreadyConsumed: true`, which is a retry of an action already taken.

Branching on `approved` alone and then acting trusts whatever came before it.

## Ask for more than yes or no

**Answer Type** decides what the reviewer is asked for:

- **Approve or Reject.** The default gate.
- **Choice.** Options you define, each with an ID your workflow branches on and
  a label the reviewer reads. The chosen IDs come back as `responseValue`.
- **Typed Answer.** A value or an explanation in their own words, also on
  `responseValue`.

**Draft for Review** takes text the reviewer can rewrite before approving: the
email you intend to send, the message you intend to post. The approved text
comes back as `output`, which is their edit when they made one and your original
when they did not. Send `output`, not what you drafted.

## Records with personal data

**Records** takes the records this decision is about, a label and a URL per row:
the ticket, the customer, the invoice. The reviewer sees them as links.

If the record holds personal data, link to it rather than copying the values into
**Data**. The system that owns the record is the one that logs who opened it and
can delete it on request. See
https://docs.ratifia.com/pii.

## Branching on the answer

The node returns the decision plus three convenience flags, `approved`,
`rejected` and `expired`, so an IF node can test one boolean instead of
string-matching a status.

When no approval was needed, because you set **Required** off or a policy decided
this case does not need review, the item passes through with
`approvalNeeded: false` and `approved: true`. The workflow continues; nothing was
sent to a person.

`expired` is a real outcome: if the decision carried a timeout and nobody
answered, it resolves as EXPIRED. Handle it. Treating it as "still waiting"
leaves the branch hanging.

## Notes

`Request Approval and Wait` polls. It does not need a public URL, so it works on
n8n Cloud, self-hosted n8n and local Docker alike, with no tunnel.

This node is verified by n8n.

Docs: https://docs.ratifia.com/n8n
