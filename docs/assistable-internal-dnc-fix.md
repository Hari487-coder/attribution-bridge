# Fix proposal (for the Assistable devs): internal DNC is bypassed by attribution

**Repo:** `assistable-buildship-replacement-be` · **File:** `packages/api/src/routes/make-call.ts` (~L845-884)
**Severity:** compliance — an explicit recorded opt-out (`DO_NOT_CONTACT`) is called anyway when the contact has attribution.

## The gap

Jorden's stated 3-part policy is: **internal DNC is absolute** (always decline); attribution only overrides the **national** registry. The shipped gate does not implement that order:

```ts
if (fromNumberIsImported && subAccount.bypassCallingCompliance) {
  // skip DNC
} else if (attributionEvidence) {
  // "DNC skipped — GHL attribution present"   ← skips the ENTIRE block below
} else {
  const [internalDnc, externalDnc] = await Promise.all([
    isOnInternalDnc(toNumber, { subAccountId: subAccount.id }),
    isOnExternalDnc(toNumber),
  ]);
  if (internalDnc)            return fail(..., "Number on internal DNC list", ...);
  if (externalDnc.registered) return fail(..., "Number on national DNC list", ...);
}
```

Because `attributionEvidence` is an `else if` that short-circuits the whole block, an **attributed** contact never reaches `isOnInternalDnc`. `addToInternalDnc` sets `status = DO_NOT_CONTACT` (not the GHL DND flag), so a normal internal opt-out is bypassed by attribution. Only a DND-flagged opt-out survives (it is checked earlier at ~L826).

**Impact:** a person who explicitly opted out (recorded internal DNC) but whose contact carries attribution will still be dialed. Ignoring a recorded do-not-contact is a worse exposure than a national-DNC hit and contradicts the policy.

## The fix (one reorder — makes code match policy)

Check internal DNC first and unconditionally (unless BYO + bypass); let attribution excuse only the national lookup.

```ts
if (fromNumberIsImported && subAccount.bypassCallingCompliance) {
  logger?.info({ toNumber, fromNumber, traceId, subAccountId: subAccount.id },
    "make-call: DNC skipped — imported (BYO) number + bypassCallingCompliance");
} else {
  // Internal DNC is ABSOLUTE — attribution never overrides an explicit
  // do-not-contact. It only excuses the national registry.
  const internalDnc = await isOnInternalDnc(toNumber, { subAccountId: subAccount.id });
  if (internalDnc) {
    return fail(reply, 403, "Number on internal DNC list", "blocked", traceId, { toNumber });
  }
  if (attributionEvidence) {
    logger?.info({ toNumber, traceId, attributionEvidence },
      "make-call: national DNC skipped — GHL attribution present (internal DNC already enforced)");
  } else {
    const externalDnc = await isOnExternalDnc(toNumber);
    if (externalDnc.registered) {
      return fail(reply, 403, "Number on national DNC list", "blocked", traceId, { toNumber });
    }
  }
}
```

Notes:
- Preserves platform hard-DNC (L785) and the DND check (L826), which stay ahead of this.
- Preserves fail-open on the external lookup and the BYO bypass.
- Slight cost: an attributed call now does one internal-DNC DB read it previously skipped. That read is the entire point.

## Test to add (`make-call.test.ts`)

- **attributed + internal DNC → 403 "Number on internal DNC list"** (the regression this fixes).
- attributed + national DNC (not internal) → allowed (unchanged).
- no attribution + national DNC → 403 (unchanged).
- BYO + bypass → skips both (unchanged).
- DND → 403 (unchanged, still ahead of attribution).

Also worth aligning the comment block at ~L767-784 to the corrected order.
