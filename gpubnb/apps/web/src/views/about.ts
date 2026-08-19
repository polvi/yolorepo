export function renderAbout(el: HTMLElement): void {
  document.title = 'gpubnb — about and limitations';
  el.innerHTML = `
    <div class="section-head"><span class="num">about</span><h2>What gpubnb is, and what it is not</h2></div>
    <div class="twocol">
      <div class="card">
        <h3>What the marketplace does</h3>
        <ul class="bullets">
          <li>Lists endpoints and the attestation doc each runner POSTs, with a per-check verdict.</li>
          <li>Re-issues challenges on heartbeat so a verified listing has to re-attest every 6 hours.</li>
          <li>Serves the offline-signed golden set and model catalog (it cannot mint entries; the signing key is not here).</li>
          <li>Keeps a dispute drop box: a runner-signed session offer plus a tx proof, for reputation only.</li>
        </ul>
        <h3 style="margin-top:14px">What it never does</h3>
        <ul class="bullets">
          <li>See prompts or completions: requests are HPKE-sealed browser → enclave.</li>
          <li>Hold, route, or take a cut of money: you pay the host's Monero subaddress directly.</li>
          <li>Ask renters to sign in. Hosts use passkeys only to mint runner tokens.</li>
        </ul>
      </div>
      <div class="card">
        <h3>Limitations, stated plainly</h3>
        <ul class="bullets">
          <li><strong>A host can still deny service after you prepay.</strong> The enclave protects confidentiality and
            integrity, not availability. Mitigations: small top-ups, runner-signed offers, receipts inside the
            stream, and the dispute count on the listing. Keep balances small.</li>
          <li><strong>Timing and volume side channels.</strong> The host sees packet sizes and timing: roughly how many
            tokens you sent and received, and when. Not what they said.</li>
          <li><strong>SEV-SNP only for now.</strong> Intel TDX quote verification comes later. GPU support: RTX PRO 6000
            Blackwell Server Edition first; H100/H200/B200/B300 by hwmodel allowlist. Workstation/Max-Q parts are
            not CC-capable and are rejected.</li>
          <li><strong>Not financial custody.</strong> gpubnb holds no funds, issues no refunds, and cannot reverse a
            Monero transfer. The runner's ledger is the host's problem; if it loses state, credits rebuild from
            the chain and unsettled debits are the host's loss.</li>
          <li><strong>The CVM image is a deterministic artifact</strong> with a published verity hash, not a
            source-reproducible build yet. You are trusting the golden measurement's signer to have built it from the
            published source.</li>
          <li><strong>Simulated listings prove the plumbing, nothing else.</strong> They are signed by a public dev key
            and are never shown as verified.</li>
        </ul>
      </div>
    </div>
    <div class="section">
      <div class="section-head"><span class="num">source</span><h2>Open protocol, open runner</h2></div>
      <p>Wire formats, attestation checks, HPKE framing, and the metering rules are specified in
      <code>PROTOCOL.md</code> in the repository; the runner (<code>gpubnbd</code>, Rust) and the
      TypeScript <code>@gpubnb/protocol</code> + <code>@gpubnb/client</code> packages implement it and share
      test vectors. Agents: see <a href="/llms.txt">/llms.txt</a>.</p>
      <p class="muted small">Auth by <a href="https://authgravity.org" rel="noopener">AuthG</a>. An
      <a href="https://infinitelogic.org" rel="noopener">Infinite Logic PBC</a> experiment.</p>
    </div>`;
}
