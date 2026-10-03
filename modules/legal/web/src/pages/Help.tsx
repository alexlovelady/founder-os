import { Link } from 'react-router-dom'

const Step = ({ n, title, children }: { n: number; title: string; children: React.ReactNode }) => (
  <div className="card" style={{ display: 'grid', gridTemplateColumns: '36px 1fr', gap: 14 }}>
    <div style={{ width: 32, height: 32, borderRadius: 16, background: 'var(--accent)', color: 'var(--accent-ink)', display: 'grid', placeItems: 'center', fontWeight: 700 }}>{n}</div>
    <div className="stack" style={{ gap: 6 }}><h3 style={{ margin: 0 }}>{title}</h3>{children}</div>
  </div>
)

export default function Help() {
  return (
    <div className="stack" style={{ gap: 18, maxWidth: 820 }}>
      <div><h1>How to use this</h1><p className="muted">A five-minute guide. Everything here runs privately: your documents are read by an AI on your own computer, and nothing is used to train anything.</p></div>

      <Step n={1} title="Set up your company (30 seconds)">
        <div>On <Link to="/">Home</Link>, enter your company name, type (LLC or corporation) and state. This builds your legal checklist and pre-fills your documents.</div>
      </Step>

      <Step n={2} title="Check the status light">
        <div>The bottom-left of the sidebar shows <strong>Private AI: Online</strong> or <strong>Offline</strong>. The AI runs on your PC, so it must be on for work to finish. If it is off, requests are saved and start by themselves when it comes back. Nothing is lost.</div>
      </Step>

      <Step n={3} title="Review a contract someone sent you">
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          <li>Choose <Link to="/review">Review a contract</Link> and drop in the file (Word, PDF, or a scan).</li>
          <li>Pick which side you are on. The same clause can help one side and hurt the other.</li>
          <li>Wait a few minutes. You get a verdict, a plain-English summary, the risks in order of importance, and questions to ask the other side.</li>
          <li>Click <strong>Download Word file with changes</strong>. Open it in Word and accept or reject each tracked change, then send it back.</li>
        </ol>
        <div className="muted small">Quoted text is checked against the contract. If a key term says "verify", read that clause yourself.</div>
      </Step>

      <Step n={4} title="Create a document">
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          <li>Choose <Link to="/create">Create a document</Link> and pick a type: founders agreement, NDA, contractor agreement, offer letter, privacy policy and more.</li>
          <li>Answer the questions. Required ones are marked *. Skip anything you do not know.</li>
          <li>Anything you leave out becomes a yellow <mark>[●BLANK]</mark> in the draft. The system never invents names, numbers or dates.</li>
          <li>Download it as Word, or <strong>Save to my documents</strong> so it counts on your checklist and can be reviewed later.</li>
        </ol>
      </Step>

      <Step n={5} title="Ask a legal question">
        <div><Link to="/ask">Ask a question</Link> in plain English. Answers use only your documents and the legal library, and every statement shows its source. Click a source tag like <span className="badge accent mono">CITE-1</span> to read the original text. Warnings mean something could not be backed up. If it says it has no source, believe it.</div>
      </Step>

      <Step n={6} title="Work through your checklist">
        <div>The checklist on Home shows what most startups need. Items turn green when you upload or create the matching document. Use <strong>Create it</strong> for what is missing, <strong>Done elsewhere</strong> for things you handled outside, or <strong>Not needed</strong>. Tax items such as the 83(b) election are reminders only. Confirm those with your tax adviser.</div>
      </Step>

      <Step n={7} title="Build up the legal library (administrator)">
        <div>Under <Link to="/authorities">Legal library</Link>, click <strong>Add every state</strong> to load LLC and corporation laws, add landmark cases, and add federal rules. The more relevant law is in the library, the better the answers. States marked "no free official source" could not be loaded automatically.</div>
      </Step>

      <div className="card stack" style={{ gap: 6 }}>
        <h3>Good to know</h3>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>This is an assistant, not a lawyer. It can miss things. Use a lawyer for equity, taxes, fundraising, disputes, or anything large.</li>
          <li><strong>Activity</strong> shows everything running or finished. <strong>Projects</strong> holds your uploaded documents. <strong>Settings</strong> has two-step sign-in (turn it on) and backups.</li>
          <li>Long contracts can take several minutes. You can leave the page; the result will be waiting.</li>
        </ul>
      </div>
    </div>
  )
}
