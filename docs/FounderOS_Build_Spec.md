# FounderOS — Full SaaS Build Specification for Claude Code

> Working title: **FounderOS**  
> Product type: AI-powered back-office operating system for founders, solopreneurs, freelancers, contractors, creators, and small businesses.  
> Core promise: **Everything you need to handle the business side of your business in one place.**

---

# 1. PRODUCT VISION

FounderOS is a subscription SaaS platform designed to help first-time founders, self-employed people, and small-business owners handle the administrative, legal-preparation, financial, operational, sales, and compliance side of running a business.

The platform should reduce the amount of time users spend:

- Googling how to run a business
- Searching through scattered documents
- Preparing paperwork
- Tracking compliance deadlines
- Creating contracts, SOPs, proposals, and policies
- Estimating finances
- Managing clients and recurring business tasks
- Figuring out what they are forgetting

The long-term differentiator is not merely a collection of AI tools.

The differentiator is a persistent **AI business operating system** that understands the user's company, documents, finances, goals, workflows, and obligations and can proactively surface what needs attention.

The product should feel like:

- AI COO
- AI business administrator
- Document assistant
- Founder dashboard
- Business health monitor

It must **not** represent itself as a law firm, attorney, accountant, tax professional, or licensed financial advisor.

---

# 2. TARGET USERS

## Primary users

1. Solopreneurs
2. Freelancers
3. Contractors
4. Creators
5. Consultants
6. First-time founders
7. Local service businesses
8. Small online businesses
9. Early-stage SaaS founders
10. Small businesses with fewer than approximately 25 employees

## Example businesses

- Cleaning company
- Landscaping company
- Mobile detailing company
- Photographer
- Web developer
- Consultant
- Marketing agency
- Online store
- Content creator
- Independent contractor
- SaaS startup
- Home-service company

---

# 3. PRODUCT POSITIONING

Do not position the platform as:

> "A bunch of AI tools for entrepreneurs."

Position it as:

> "Your back office for starting and running a business."

Alternative positioning:

> "Everything you need to run the business side of your business."

> "An AI operating system for small business."

> "Know what your business needs before it becomes a problem."

---

# 4. CORE PRODUCT PILLARS

The platform is organized around the following modules:

1. Business Profile
2. Founder AI
3. LegalAI
4. Document Vault
5. Compliance Center
6. Business Health
7. Finance Tools
8. Documents & SOPs
9. CRM & Sales
10. Marketing Tools
11. Tasks & Reminders
12. Integrations
13. Team & Permissions
14. Billing & Subscription
15. Admin System

The MVP should prioritize:

- Authentication
- Business Profile
- Founder AI
- LegalAI
- Document Vault
- Compliance Center
- Business Health
- Core Finance Calculators
- Billing
- Admin

Do not build every module at once.

---

# 5. RECOMMENDED TECH STACK

## Frontend

- Next.js
- TypeScript
- React
- Tailwind CSS
- shadcn/ui
- Lucide icons

## Backend

Primary recommendation:

- Next.js server actions / API routes
- Firebase Authentication
- Firestore
- Firebase Storage

Optional future backend extraction:

- Node.js / TypeScript service
- Python microservices for document processing or specialized analysis

## Authentication

Firebase Auth:

- Email/password
- Google
- Microsoft
- Magic link if practical

Future:

- Passkeys
- SSO for business plans

## Database

Firestore for MVP.

Collections should be designed so migration to PostgreSQL is possible later.

Potential future database:

- PostgreSQL
- Supabase
- Cloud SQL

## File Storage

Firebase Storage initially.

Future storage providers:

- Google Drive
- Dropbox
- OneDrive
- S3-compatible storage

## AI Layer

Provider abstraction.

Do not hard-code the application to one AI provider.

Create an interface such as:

```ts
interface AIProvider {
  complete(input: AIRequest): Promise<AIResponse>;
  stream(input: AIRequest): AsyncIterable<string>;
  embed(text: string): Promise<number[]>;
}
```

Initial provider may use:

- OpenAI
- Anthropic

The admin panel should eventually allow selecting a default model by task type.

## Billing

Stripe

Use:

- Stripe Checkout
- Stripe Customer Portal
- Webhooks
- Subscription status synchronization

## Email

Preferred:

- Resend

Use for:

- Verification
- Compliance reminders
- Trial notifications
- Billing notices
- Weekly business summary
- Document alerts

## Background Jobs

MVP:

- Vercel cron or Firebase scheduled functions

Future:

- Trigger.dev
- Inngest
- Temporal

## Search / RAG

MVP:

- Firestore metadata
- Vector embeddings
- Vector-enabled service or database

Options:

- Pinecone
- pgvector
- Firebase vector search if suitable
- Qdrant

Abstract the vector store behind an internal service.

---

# 6. APPLICATION STRUCTURE

Suggested routes:

```text
/
├── /
├── /pricing
├── /features
├── /legal-ai
├── /business-health
├── /login
├── /signup
├── /onboarding
│
├── /app
│   ├── /dashboard
│   ├── /assistant
│   ├── /legal
│   ├── /documents
│   ├── /compliance
│   ├── /health
│   ├── /finance
│   ├── /sops
│   ├── /crm
│   ├── /marketing
│   ├── /tasks
│   ├── /integrations
│   ├── /team
│   └── /settings
│
└── /admin
    ├── /users
    ├── /businesses
    ├── /subscriptions
    ├── /usage
    ├── /ai
    ├── /templates
    ├── /compliance-rules
    ├── /feedback
    └── /system
```

---

# 7. AUTHENTICATION & ACCOUNT MODEL

Users can belong to one or more businesses.

## User

```ts
interface User {
  id: string;
  email: string;
  displayName: string;
  photoURL?: string;

  createdAt: Timestamp;
  updatedAt: Timestamp;

  onboardingComplete: boolean;

  defaultBusinessId?: string;

  subscriptionCustomerId?: string;
}
```

## Business

```ts
interface Business {
  id: string;

  ownerId: string;

  name: string;
  legalName?: string;
  description?: string;

  entityType?: string;
  industry?: string;

  country: string;
  state?: string;
  city?: string;

  website?: string;

  startDate?: string;

  employeeCount?: number;

  annualRevenueRange?: string;

  lifecycleStage:
    | "idea"
    | "forming"
    | "pre_revenue"
    | "operating"
    | "growing";

  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

## Membership

```ts
interface BusinessMembership {
  id: string;

  businessId: string;
  userId: string;

  role:
    | "owner"
    | "admin"
    | "manager"
    | "member"
    | "viewer";

  createdAt: Timestamp;
}
```

---

# 8. ONBOARDING

Onboarding should be short enough not to discourage signup but detailed enough to customize the system.

## Step 1 — User

Ask:

- Name
- Email
- Password or OAuth

## Step 2 — Business

Ask:

- Business name
- What does the business do?
- Industry
- Country
- State
- City
- Business stage

## Step 3 — Structure

Ask:

- Sole proprietor
- LLC
- Partnership
- Corporation
- S-Corp taxation
- Not formed yet
- Not sure

Do not interpret the answer as legal advice.

## Step 4 — Operations

Ask:

- Employees?
- Contractors?
- Customers?
- Online payments?
- Recurring subscriptions?
- Handles customer personal data?
- Collects health information?
- Works with minors?
- Has a website?
- Sells across state lines?

These answers contribute to Business Health and compliance suggestions.

## Step 5 — Goals

Examples:

- Start my business
- Stay compliant
- Review contracts
- Organize documents
- Improve finances
- Find customers
- Build processes
- Prepare to hire

## Step 6 — Dashboard Initialization

Create:

- Business health checklist
- Compliance checklist
- Initial recommendations
- Suggested documents
- Suggested next actions

---

# 9. MAIN DASHBOARD

The dashboard should feel like a command center.

## Header

Display:

- Business selector
- Current business
- Notifications
- Search
- User profile

## Main greeting

Example:

> Good afternoon, Alex.

Then display:

> Your business has 3 items that may need attention.

## Dashboard Cards

### Attention Needed

Examples:

- Contractor agreement may need review
- Annual report due soon
- Privacy policy missing
- Business insurance not documented
- Tax reserve not configured

### Business Health

Show category completion visually:

- Legal
- Finance
- Compliance
- Operations
- Sales
- Security

Avoid presenting arbitrary "business success scores."

Prefer:

- Complete
- Needs attention
- Missing
- Not applicable

### Upcoming

Display:

- Deadlines
- Renewals
- Recurring tasks
- Document expirations

### Financial Snapshot

Display when financial data is available:

- Revenue
- Expenses
- Net cash flow
- Runway
- Tax reserve estimate

### Documents

Display:

- Recently uploaded
- Recently reviewed
- Needs signature
- Expiring soon

### Ask Your Business

Persistent AI input:

> Ask anything about your company...

Example prompts:

- What should I work on this week?
- Review my current business risks.
- What am I missing before hiring a contractor?
- Can I afford another employee?
- Summarize this month's business activity.

---

# 10. FOUNDER AI

Founder AI is a persistent assistant grounded in company context.

## Requirements

Founder AI should understand:

- Business profile
- Uploaded documents
- Prior AI conversations
- Compliance state
- Financial summaries
- CRM data
- Tasks
- SOPs
- Connected integrations
- User permissions

## Assistant responsibilities

Examples:

### Business Administration

- Explain business workflows
- Generate checklists
- Recommend next steps
- Identify missing information
- Organize work

### Document Work

- Find documents
- Summarize documents
- Compare versions
- Generate drafts
- Explain clauses

### Finance

- Explain cash flow
- Calculate runway
- Summarize trends
- Estimate costs
- Assist with pricing

### Operations

- Generate SOPs
- Create onboarding workflows
- Generate recurring processes

### Sales

- Draft proposals
- Build follow-up sequences
- Summarize customer history

## Important AI behavior

The assistant should distinguish between:

1. Facts from connected company data
2. General informational guidance
3. AI interpretation
4. Suggested actions

Do not fabricate facts about the user's business.

If information is missing, say so.

---

# 11. AI CONTEXT SYSTEM

Build an internal Business Context Service.

Example:

```ts
interface BusinessContext {
  profile: Business;

  healthItems: HealthItem[];

  upcomingDeadlines: ComplianceDeadline[];

  recentDocuments: DocumentSummary[];

  financialSummary?: FinancialSummary;

  tasks: Task[];

  crmSummary?: CRMSummary;

  userRole: string;
}
```

When Founder AI receives a message:

1. Identify user intent.
2. Determine which internal resources are required.
3. Retrieve only necessary data.
4. Retrieve relevant document chunks if needed.
5. Construct context.
6. Send request to AI.
7. Save message.
8. Save tool execution metadata.
9. Stream answer to UI.

Avoid putting the entire business database into every prompt.

---

# 12. AI TOOL CALLING

Implement internal AI tools.

Examples:

```text
get_business_profile
search_documents
read_document
list_compliance_items
get_financial_summary
calculate_runway
create_task
list_tasks
generate_document
compare_documents
get_crm_customer
search_crm
create_sop
```

Tool permissions must respect user role.

Do not allow AI to perform destructive actions without explicit confirmation.

Examples requiring confirmation:

- Delete document
- Delete client
- Send email
- Cancel subscription
- Remove team member
- Modify billing
- Overwrite document

---

# 13. LEGALAI MODULE

LegalAI is one of the main acquisition features.

## Positioning

LegalAI helps users:

- Understand documents
- Find potential issues
- Prepare questions
- Draft or improve documents
- Organize material before consulting a lawyer

It must not claim:

- Attorney-client privilege
- Attorney status
- Legal representation
- Guaranteed legal correctness

## Landing Copy Example

> Review, understand, and improve your business documents before you take them to a lawyer.

---

# 14. LEGALAI FEATURES

## Upload and Review

Supported file types:

- PDF
- DOCX
- TXT
- MD

Potential future:

- Images
- Scanned PDFs

## Review Modes

User chooses:

- General review
- Risk review
- Plain-English explanation
- Negotiation review
- Missing clause review
- Compare against another version
- Prepare lawyer questions
- Improve wording

## Review Output

Structure responses into:

### Document Summary

Short summary.

### Key Terms

Examples:

- Parties
- Payment
- Term
- Renewal
- Termination
- Liability
- Governing law

### Potential Concerns

Each issue should contain:

- Clause
- Why it may matter
- Severity:
  - Information
  - Review recommended
  - High attention
- Suggested question
- Possible revision

Avoid declaring clauses legally invalid unless grounded in authoritative information.

### Missing Items

Example:

- No termination provision detected
- No confidentiality clause detected

### Questions for Your Lawyer

Generate concise questions.

### Suggested Rewrite

Allow user to select a clause and request:

- Friendlier
- More balanced
- More protective
- Shorter
- Clearer

---

# 15. LEGAL DOCUMENT GENERATOR

Generate drafts for:

- NDA
- Independent contractor agreement
- Service agreement
- Basic consulting agreement
- Website terms
- Privacy policy
- Payment terms
- Refund policy
- Photo/media release
- Simple partnership discussion template
- Contractor onboarding checklist

Every generated document should contain metadata:

```ts
interface GeneratedDocument {
  id: string;
  businessId: string;

  templateType: string;

  generatedAt: Timestamp;
  generatedBy: string;

  jurisdiction?: string;

  version: number;

  status:
    | "draft"
    | "review"
    | "approved"
    | "archived";
}
```

Display a notice that generated legal documents should be reviewed for applicability and may require professional review.

---

# 16. DOCUMENT VAULT

The Document Vault is the central business file system.

## Categories

- Formation
- Legal
- Contracts
- Taxes
- Finance
- Insurance
- Employees
- Contractors
- Customers
- Vendors
- Policies
- SOPs
- Marketing
- Other

## Features

- Upload
- Rename
- Move
- Tag
- Search
- Filter
- Archive
- Version history
- AI summary
- AI search
- Review status
- Expiration date
- Reminder
- Related business contact
- Related compliance item

## Document Model

```ts
interface BusinessDocument {
  id: string;

  businessId: string;
  ownerId: string;

  name: string;
  originalFilename: string;

  category: string;
  mimeType: string;

  storagePath: string;

  tags: string[];

  version: number;

  status:
    | "active"
    | "draft"
    | "review"
    | "archived";

  uploadedAt: Timestamp;

  expirationDate?: Timestamp;

  aiSummary?: string;
}
```

---

# 17. DOCUMENT PROCESSING PIPELINE

When a document is uploaded:

1. Validate file.
2. Store original.
3. Extract text.
4. Detect language.
5. Identify document type.
6. Create summary.
7. Split into semantic chunks.
8. Generate embeddings.
9. Save embeddings.
10. Extract metadata where useful.
11. Offer review actions.

Document chunks:

```ts
interface DocumentChunk {
  id: string;
  businessId: string;
  documentId: string;

  text: string;

  page?: number;

  chunkIndex: number;

  embeddingId?: string;
}
```

---

# 18. COMPLIANCE CENTER

The Compliance Center tracks business obligations and reminders.

This system should be configurable and should not hard-code every legal requirement directly into application code.

Use a Compliance Rules database.

## Categories

- Entity filing
- Annual reports
- Business licenses
- Registered agent
- Sales tax
- Payroll
- Contractor documentation
- Insurance
- Website privacy
- Security
- Industry-specific items

## Compliance Item

```ts
interface ComplianceItem {
  id: string;

  businessId: string;

  ruleId?: string;

  title: string;

  description: string;

  category: string;

  status:
    | "complete"
    | "attention"
    | "missing"
    | "not_applicable";

  dueDate?: Timestamp;

  recurring?: boolean;

  recurrenceRule?: string;

  sourceURL?: string;

  completedAt?: Timestamp;

  supportingDocumentId?: string;
}
```

---

# 19. COMPLIANCE RULES ENGINE

Rules should evaluate business characteristics.

Example rule:

```ts
{
  "id": "website_privacy_policy",
  "conditions": {
    "hasWebsite": true,
    "collectsPersonalData": true
  },
  "recommendation": "Review whether your website requires a privacy policy."
}
```

Another:

```ts
{
  "id": "contractor_agreement",
  "conditions": {
    "usesContractors": true
  },
  "recommendation": "Maintain written contractor agreements."
}
```

Rules should support:

- Country
- State
- Entity type
- Industry
- Employees
- Contractors
- Personal data
- Health data
- Online sales
- Physical location

---

# 20. BUSINESS HEALTH

Business Health answers:

> "What am I forgetting?"

Categories:

## Legal

Examples:

- Business entity information documented
- Operating agreement uploaded
- Customer agreement available
- Contractor agreement available
- Privacy policy available

## Compliance

Examples:

- Annual filings tracked
- Licenses tracked
- Insurance tracked

## Finance

Examples:

- Business banking established
- Accounting method documented
- Tax reserve configured
- Emergency reserve target configured

## Operations

Examples:

- Core SOPs created
- Customer onboarding process
- Incident plan
- Backup plan

## Sales

Examples:

- CRM enabled
- Proposal template
- Follow-up process
- Customer pipeline

## Security

Examples:

- MFA enabled
- Password manager policy
- Data backup process
- Access review

Health items:

```ts
interface HealthItem {
  id: string;

  businessId: string;

  category: string;

  title: string;

  description?: string;

  status:
    | "complete"
    | "attention"
    | "missing"
    | "not_applicable";

  source:
    | "rule"
    | "manual"
    | "integration"
    | "ai";

  relatedResourceId?: string;

  updatedAt: Timestamp;
}
```

---

# 21. FINANCE MODULE

The initial Finance module should focus on decision tools rather than trying to replace full accounting software.

## MVP Calculators

### Runway Calculator

Inputs:

- Cash on hand
- Monthly recurring revenue
- Other monthly revenue
- Monthly expenses

Outputs:

- Net burn
- Runway
- Break-even point

### Break-Even Calculator

Inputs:

- Fixed expenses
- Variable expense per sale
- Sale price

Output:

- Break-even sales volume

### Pricing Calculator

Inputs:

- Labor
- Materials
- Overhead
- Desired margin

Outputs:

- Minimum price
- Target price
- Margin

### Contractor vs Employee Calculator

Inputs:

- Hourly rate / salary
- Payroll costs
- Benefits
- Contractor rate

Output:

Estimated cost comparison.

Clearly explain that classification is a legal/tax question and cost comparison does not determine classification.

### Tax Reserve Estimator

User manually chooses reserve percentage.

Do not represent it as a tax return calculation.

---

# 22. FUTURE FINANCIAL CONNECTIONS

Potential integrations:

- Plaid
- Stripe
- QuickBooks
- Xero

Possible dashboard metrics:

- Revenue
- Expenses
- Cash flow
- Burn
- Runway
- Largest expense categories
- Accounts receivable
- Subscription revenue

Finance data must have clear source labels.

---

# 23. SOP BUILDER

Allow users to create SOPs manually or with AI.

## SOP Creation Inputs

Ask:

- Process name
- Goal
- Who performs it
- Inputs
- Steps
- Exceptions
- Expected result

Output:

```text
Title
Purpose
Owner
Frequency
Required Tools
Prerequisites
Procedure
Quality Checks
Exceptions
Escalation
Revision History
```

Users can:

- Edit
- Save
- Version
- Assign
- Export PDF
- Export DOCX
- Convert into checklist

---

# 24. BUSINESS DOCUMENT GENERATOR

Create business documents such as:

- Proposal
- Quote
- Invoice template
- Business plan
- One-page business overview
- Job description
- Employee onboarding checklist
- Contractor onboarding checklist
- Policy
- Client onboarding guide
- Meeting agenda
- Meeting summary
- Process checklist

Generated content should use stored Business Profile data automatically.

---

# 25. CRM — POST MVP

Keep CRM lightweight.

## Features

- Leads
- Customers
- Contacts
- Pipeline
- Notes
- Tasks
- Email history
- Proposals
- Contracts
- Documents

## Contact

```ts
interface Contact {
  id: string;

  businessId: string;

  type:
    | "lead"
    | "customer"
    | "vendor"
    | "partner";

  name: string;
  company?: string;

  email?: string;
  phone?: string;

  status?: string;

  createdAt: Timestamp;
}
```

## Opportunities

Pipeline stages:

- Lead
- Contacted
- Qualified
- Proposal sent
- Negotiation
- Won
- Lost

Allow custom stages later.

---

# 26. MARKETING TOOLS — POST MVP

Potential features:

- Brand voice
- Customer persona
- Social copy
- Email drafts
- Landing-page copy
- Ad copy
- Review replies
- SEO ideas
- Blog outlines
- Content calendar

Do not make the marketing suite the primary product.

---

# 27. TASK SYSTEM

FounderOS should have a universal task engine.

Tasks can originate from:

- User
- Compliance
- AI
- Document
- CRM
- Finance
- Integration

Task model:

```ts
interface Task {
  id: string;

  businessId: string;

  title: string;
  description?: string;

  status:
    | "todo"
    | "in_progress"
    | "done";

  priority:
    | "low"
    | "medium"
    | "high";

  dueDate?: Timestamp;

  assignedTo?: string;

  source:
    | "manual"
    | "ai"
    | "compliance"
    | "document"
    | "crm"
    | "system";

  sourceId?: string;

  createdAt: Timestamp;
  completedAt?: Timestamp;
}
```

---

# 28. NOTIFICATIONS

Notification types:

- Compliance deadline
- Document expiration
- Task due
- Subscription issue
- Trial expiration
- AI finding
- Integration failure

Channels:

- In-app
- Email

Future:

- SMS
- Push notification

Allow notification preferences.

---

# 29. WEEKLY BUSINESS BRIEF

Premium users should receive a weekly summary.

Example:

```text
Your weekly business brief

Needs attention:
- Annual report due in 21 days
- Contractor agreement review incomplete

Finance:
- Revenue increased 12%
- Largest expense category: software

Operations:
- 3 overdue tasks
- 1 SOP updated

Recommended next actions:
1. Complete annual report checklist
2. Review contractor agreement
3. Follow up with 4 open leads
```

Generate from real platform data.

---

# 30. GLOBAL SEARCH

Search across:

- Documents
- Contacts
- SOPs
- Tasks
- AI conversations
- Compliance
- Business profile

Keyboard shortcut:

```text
Ctrl/Cmd + K
```

Allow commands such as:

- New document
- Ask Founder AI
- Upload document
- Create task
- Search customer

---

# 31. INTEGRATIONS

Build an Integration Manager.

## MVP Integrations

Priority:

1. Google Drive
2. Gmail
3. Google Calendar
4. Stripe

Future:

- QuickBooks
- Xero
- Plaid
- Dropbox
- OneDrive
- Slack
- HubSpot
- Square
- Shopify
- Zapier
- Make.com

## Integration Model

```ts
interface IntegrationConnection {
  id: string;

  businessId: string;

  provider: string;

  status:
    | "connected"
    | "expired"
    | "error"
    | "disconnected";

  scopes: string[];

  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

Never expose raw access tokens to client code.

Encrypt stored credentials.

---

# 32. AUTOMATION ENGINE — FUTURE

Eventually allow users to create workflows.

Example:

```text
When:
A new contract is uploaded

Then:
Run LegalAI review
Generate summary
Create task if high-attention item exists
Notify owner
```

Other examples:

```text
When a customer becomes "Won"
→ Generate onboarding checklist
→ Create folder
→ Draft welcome email
```

```text
30 days before annual report due
→ Notify owner
→ Create task
→ Show dashboard alert
```

Start with system-created automation rules before building a user-facing workflow builder.

---

# 33. SUBSCRIPTION MODEL

Suggested tiers.

## Free

Potential:

- Business profile
- Startup checklist
- Limited calculators
- Limited AI usage
- Limited document uploads
- Basic templates

## Founder

Target:

$19-$29/month

Potential:

- Founder AI
- LegalAI
- Document Vault
- Compliance
- Business Health
- Core generators
- Higher usage

## Pro

Target:

$49-$79/month

Potential:

- Financial connections
- Advanced AI
- CRM
- Integrations
- Automations
- More storage
- More team members

## Business

Starting around:

$149/month

Potential:

- Larger teams
- Permissions
- Advanced integrations
- Audit history
- Priority support
- Custom workflows

Prices should remain configuration values.

Do not hard-code pricing across the application.

---

# 34. STRIPE IMPLEMENTATION

Stripe products should map into internal plans.

Internal plan model:

```ts
interface Subscription {
  id: string;

  userId: string;
  businessId?: string;

  stripeCustomerId: string;
  stripeSubscriptionId?: string;

  plan:
    | "free"
    | "founder"
    | "pro"
    | "business";

  status:
    | "active"
    | "trialing"
    | "past_due"
    | "canceled"
    | "unpaid";

  currentPeriodEnd?: Timestamp;
}
```

Required webhook events:

- checkout.session.completed
- customer.subscription.created
- customer.subscription.updated
- customer.subscription.deleted
- invoice.paid
- invoice.payment_failed

Stripe is source of truth for billing.

---

# 35. USAGE LIMITING

Track:

- AI requests
- Input tokens
- Output tokens
- Documents analyzed
- Storage usage
- Document generations

Model:

```ts
interface UsageEvent {
  id: string;

  userId: string;
  businessId: string;

  type: string;

  quantity: number;

  model?: string;

  estimatedCost?: number;

  createdAt: Timestamp;
}
```

Admin should be able to configure plan limits.

---

# 36. AI COST CONTROL

Implement:

- Request size limits
- Model routing
- Context trimming
- RAG instead of full-document prompts
- Cached summaries
- Rate limits
- Usage caps
- Per-feature model configuration

Example:

```text
Document extraction → cheap model
Simple rewrite → cheap model
Complex LegalAI review → strong model
Founder AI planning → strong model
Classification → cheap model
Embeddings → embedding model
```

---

# 37. SECURITY REQUIREMENTS

Because the platform may contain confidential business documents, security is a core product requirement.

## Minimum requirements

- HTTPS
- Firebase Auth
- Role-based access control
- Server-side authorization
- MFA support
- Storage ACLs
- Secure session handling
- Input validation
- File validation
- Rate limiting
- Audit logs
- Encryption in transit
- Encryption at rest through infrastructure provider
- Secrets stored only in server environment variables
- No API keys in frontend
- CSRF protection where applicable
- XSS protection
- Security headers
- Content Security Policy
- Dependency scanning

---

# 38. FILE SECURITY

For uploads:

- Allow only approved MIME types
- Limit file size
- Rename internally using UUIDs
- Never execute uploaded files
- Malware scanning if possible
- Store metadata separately
- Use signed URLs
- Expire download links
- Confirm user has business access before file retrieval

---

# 39. DATA ACCESS CONTROL

Every database query should be scoped by:

```text
authenticated user
+
business membership
+
required role
```

Do not rely only on frontend hiding.

Example:

```ts
assertBusinessAccess(userId, businessId);
```

Use a reusable authorization middleware/service.

---

# 40. AUDIT LOG

Track important actions.

Examples:

- Login
- Document uploaded
- Document deleted
- LegalAI review executed
- User invited
- User removed
- Settings changed
- Integration connected
- Subscription changed
- Compliance item marked complete

```ts
interface AuditEvent {
  id: string;

  businessId: string;
  userId?: string;

  action: string;

  resourceType?: string;
  resourceId?: string;

  metadata?: Record<string, unknown>;

  createdAt: Timestamp;
}
```

Do not store secrets in logs.

---

# 41. PRIVACY CONTROLS

Users should be able to:

- Export business data
- Delete business data
- Delete account
- Disconnect integrations
- Remove documents
- Control AI data usage where applicable

Implement retention settings later.

---

# 42. AI SAFETY / PROFESSIONAL SERVICES BOUNDARIES

LegalAI should clearly indicate:

> FounderOS provides software tools and general informational assistance. It is not a law firm and does not provide legal representation.

Finance features should indicate:

> Financial tools provide estimates and general business information and do not replace accounting, tax, or financial professionals.

Do not clutter every page with giant disclaimers.

Use:

- onboarding acknowledgement
- clear contextual notices
- footer legal pages
- relevant notices where professional advice boundaries matter

---

# 43. UI / DESIGN SYSTEM

Design should feel:

- Modern
- Professional
- Clean
- Founder-focused
- Trustworthy
- Premium but simple

Avoid:

- Cartoon startup aesthetic
- Excessive gradients
- Overly playful UI
- Dense enterprise dashboards

Suggested layout:

```text
Desktop

┌─────────────────────────────────────────────┐
│ Header                                      │
├────────────┬────────────────────────────────┤
│ Sidebar    │ Page content                   │
│            │                                │
│ Dashboard  │                                │
│ Assistant  │                                │
│ Legal      │                                │
│ Documents  │                                │
│ Compliance │                                │
│ Health     │                                │
│ Finance    │                                │
│ ...        │                                │
└────────────┴────────────────────────────────┘
```

Mobile:

- Bottom navigation for primary features
- Drawer for secondary features

---

# 44. SIDEBAR

Suggested primary navigation:

```text
Dashboard
Ask FounderOS

LEGAL & ADMIN
LegalAI
Documents
Compliance
Business Health

MONEY
Finance

OPERATIONS
Tasks
SOPs

GROWTH
CRM
Marketing

BUSINESS
Integrations
Team
Settings
```

Post-MVP sections can be hidden until released.

---

# 45. ADMIN PORTAL

Build a separate protected admin role.

## Dashboard

Show:

- Users
- Businesses
- Active subscriptions
- MRR
- Trial users
- Conversion
- Churn
- AI usage
- AI cost
- Storage usage
- Errors

## Users

Admin can:

- Search
- View status
- View subscription
- Suspend
- Restore
- View usage

Do not expose user documents unnecessarily.

## AI Admin

Configure:

- Providers
- Models
- Feature routing
- Token limits
- Temperature
- System prompts
- Usage caps

## Templates

Manage:

- Legal templates
- SOP templates
- Document templates
- Email templates

## Compliance Rules

Admin interface should allow:

- Create
- Edit
- Disable
- Version
- Add source URL
- Add jurisdictions
- Add conditions

---

# 46. ANALYTICS

Track product events.

Examples:

```text
signup_completed
onboarding_completed

document_uploaded
document_review_started
document_review_completed

founder_ai_message

health_item_completed

compliance_item_completed

calculator_used

subscription_started
subscription_upgraded
subscription_canceled
```

Potential tools:

- PostHog
- Firebase Analytics
- Plausible

PostHog is recommended for product analytics.

---

# 47. ERROR MONITORING

Recommended:

- Sentry

Track:

- Frontend errors
- Backend exceptions
- API failures
- AI failures
- Integration errors

Associate errors with internal user IDs where appropriate but avoid leaking sensitive data.

---

# 48. LOGGING

Use structured logs.

Example:

```json
{
  "event": "legal_review_completed",
  "businessId": "...",
  "documentId": "...",
  "model": "...",
  "durationMs": 8421
}
```

Never log:

- Passwords
- OAuth tokens
- Full documents
- API keys
- Sensitive prompt contents unless specifically necessary and protected

---

# 49. ENVIRONMENT VARIABLES

Example:

```env
NEXT_PUBLIC_APP_URL=

NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=

FIREBASE_ADMIN_PROJECT_ID=
FIREBASE_ADMIN_CLIENT_EMAIL=
FIREBASE_ADMIN_PRIVATE_KEY=

STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

RESEND_API_KEY=

OPENAI_API_KEY=
ANTHROPIC_API_KEY=

SENTRY_DSN=

POSTHOG_KEY=
```

Do not commit `.env` files.

Provide `.env.example`.

---

# 50. FOLDER STRUCTURE

Suggested structure:

```text
src/
├── app/
│   ├── (marketing)/
│   ├── (auth)/
│   ├── app/
│   ├── admin/
│   └── api/
│
├── components/
│   ├── ui/
│   ├── dashboard/
│   ├── documents/
│   ├── legal/
│   ├── health/
│   └── layout/
│
├── lib/
│   ├── auth/
│   ├── firebase/
│   ├── stripe/
│   ├── ai/
│   ├── documents/
│   ├── compliance/
│   ├── permissions/
│   └── validation/
│
├── services/
│   ├── ai/
│   ├── business-context/
│   ├── document-processing/
│   ├── legal/
│   ├── compliance/
│   ├── finance/
│   └── notifications/
│
├── types/
├── hooks/
├── config/
└── utils/
```

---

# 51. VALIDATION

Use Zod.

Example:

```ts
const BusinessSchema = z.object({
  name: z.string().min(1).max(150),
  industry: z.string().optional(),
  country: z.string(),
  state: z.string().optional(),
});
```

Validate:

- API input
- Forms
- Webhooks
- AI tool arguments

Never trust client-submitted role or business IDs without authorization checks.

---

# 52. API DESIGN

Use consistent responses.

Example:

```json
{
  "success": true,
  "data": {}
}
```

Errors:

```json
{
  "success": false,
  "error": {
    "code": "DOCUMENT_NOT_FOUND",
    "message": "Document could not be found."
  }
}
```

Do not expose internal stack traces to users.

---

# 53. LEGALAI REVIEW PIPELINE

Implement approximately:

```text
Upload document
↓
Extract text
↓
Classify document
↓
Extract structural clauses
↓
Retrieve relevant internal review framework
↓
Run AI review
↓
Validate structured result
↓
Store review
↓
Display report
```

Use structured output.

Example:

```ts
interface LegalReview {
  documentType: string;

  summary: string;

  parties: string[];

  keyTerms: {
    name: string;
    value: string;
  }[];

  issues: {
    title: string;
    clauseText?: string;

    severity:
      | "information"
      | "review"
      | "high_attention";

    explanation: string;

    suggestedQuestion?: string;

    suggestedRevision?: string;
  }[];

  missingClauses: string[];

  lawyerQuestions: string[];
}
```

Do not allow malformed model output directly into UI.

Validate with Zod.

---

# 54. DOCUMENT COMPARISON

Allow:

```text
Version A
vs
Version B
```

Output:

- Added clauses
- Removed clauses
- Modified clauses
- Payment changes
- Liability changes
- Term changes
- Termination changes
- Other meaningful changes

Allow filters:

- All changes
- Financial changes
- Legal risk changes
- Operational changes

---

# 55. BUSINESS HEALTH ENGINE

Health engine should evaluate:

```text
Business Profile
+
Documents
+
Compliance
+
Integrations
+
User confirmations
```

Example:

```text
usesContractors = true

AND

no active contractor agreement detected

→ Health item:
"Contractor agreement missing"
```

Another:

```text
hasWebsite = true
AND
collectsPersonalData = true
AND
no privacy policy document detected

→ Health item:
"Review whether a privacy policy is needed"
```

Use cautious wording when the system cannot conclusively determine legal requirements.

---

# 56. SEARCH & RAG

Documents should support semantic search.

Query:

> What does my contractor agreement say about termination?

Process:

1. Convert query to embedding.
2. Search chunks for selected business.
3. Retrieve top relevant chunks.
4. Send chunks and metadata to AI.
5. Respond with citations to document/page where available.

Never retrieve data across businesses.

---

# 57. AI CONVERSATION STORAGE

```ts
interface Conversation {
  id: string;

  businessId: string;
  userId: string;

  title: string;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

```ts
interface ChatMessage {
  id: string;

  conversationId: string;

  role:
    | "user"
    | "assistant"
    | "tool";

  content: string;

  createdAt: Timestamp;

  metadata?: Record<string, unknown>;
}
```

Allow users to delete conversations.

---

# 58. EXPORTS

Users should eventually be able to export:

- Documents
- LegalAI report PDF
- Business Health report
- SOP PDF
- Business profile
- Compliance list
- Finance calculations
- CRM contacts

Possible formats:

- PDF
- CSV
- DOCX
- JSON

---

# 59. COLLABORATION

Pro/Business users can invite:

- Co-founder
- Employee
- Accountant
- Attorney
- Consultant

Role permissions should be configurable later.

Initial roles:

```text
Owner
Admin
Member
Viewer
```

Potential professional guest mode:

```text
Accountant
Attorney
```

Guest users should access only explicitly shared sections.

---

# 60. LAWYER / ACCOUNTANT COLLABORATION — FUTURE DIFFERENTIATOR

One powerful future feature:

> Prepare before you meet your professional.

Example LegalAI workflow:

1. User uploads contract.
2. LegalAI reviews.
3. User marks concerns.
4. FounderOS generates "Attorney Review Packet."
5. User shares packet with lawyer.

Packet includes:

- Original document
- Summary
- User concerns
- AI-detected clauses
- Questions
- Business context

Similar accountant workflow:

- Financial summary
- Expense categories
- Tax-related questions
- Uploaded tax docs

FounderOS should assist professionals rather than position itself against them.

---

# 61. STARTUP CHECKLIST

For pre-launch businesses create a guided workflow:

```text
Define business
Choose structure
Register business
Obtain EIN
Open bank account
Set accounting process
Review required licenses
Create customer agreement
Create privacy policy if applicable
Set up invoicing
Configure insurance tracking
Launch website
```

Items vary based on business profile.

Use links to authoritative government sources where possible.

---

# 62. KNOWLEDGE SOURCES

Create a source layer for factual compliance content.

Each rule should contain:

- Source title
- Source URL
- Jurisdiction
- Last verified date
- Version

Do not allow compliance content to become an untraceable AI hallucination.

Future task:

Build a verification queue in admin for stale rules.

---

# 63. DATABASE COLLECTIONS

Suggested Firestore structure:

```text
users
businesses
business_memberships

documents
document_chunks
document_versions

legal_reviews
generated_documents

compliance_rules
compliance_items

health_items

tasks

conversations
chat_messages

contacts
opportunities

sops

integrations

notifications

subscriptions
usage_events

audit_events

templates

feedback
system_settings
```

Every business-owned record must contain:

```text
businessId
```

---

# 64. FIRESTORE INDEXES

Prepare indexes for common filters:

- businessId + createdAt
- businessId + status
- businessId + category
- businessId + dueDate
- businessId + documentType
- businessId + source

Document all required indexes in repository setup instructions.

---

# 65. FIREBASE SECURITY RULES

Do not leave Firestore in test mode.

Use membership checks.

Pseudo example:

```text
allow read:
if authenticated
and user belongs to resource.businessId

allow write:
if authenticated
and user role allows action
```

Server-side Admin SDK routes still require explicit authorization logic.

---

# 66. TESTING

Testing layers:

## Unit Tests

Test:

- Calculators
- Validators
- Rule engine
- Permission logic
- Billing mapping

## Integration Tests

Test:

- Stripe webhooks
- Document upload
- LegalAI review
- AI tool calls
- Compliance generation

## E2E

Use Playwright.

Critical flows:

1. Signup
2. Onboarding
3. Upload contract
4. Review contract
5. Ask Founder AI
6. Mark health item complete
7. Upgrade subscription
8. Invite team member
9. Delete account

---

# 67. DEMO DATA

Create development seed data.

Example business:

```text
BrightSide Cleaning LLC

Industry:
Residential cleaning

Employees:
2

Contractors:
1

State:
North Carolina

Website:
Yes

Recurring customers:
Yes
```

Seed:

- Customer service agreement
- Contractor agreement
- Privacy policy
- Compliance item
- Task list
- Sample financial data

This makes development and demos much faster.

---

# 68. ACCESSIBILITY

Target WCAG 2.1 AA where practical.

Requirements:

- Keyboard navigation
- ARIA labels
- Contrast
- Focus indicators
- Screen-reader-friendly forms
- Accessible modals
- Descriptive error messages

---

# 69. MOBILE RESPONSIVENESS

All core functions must work on mobile.

Prioritize:

- Dashboard
- AI chat
- Document upload
- Compliance
- Tasks
- Notifications

Large legal review reports may use optimized mobile cards instead of desktop tables.

---

# 70. PERFORMANCE

Targets:

- Marketing pages load quickly
- Dashboard initial render under reasonable network conditions
- AI responses stream
- Large document processing happens asynchronously
- Uploaded files show processing state

Statuses:

```text
Uploading
Processing
Ready
Failed
```

Never make the UI appear frozen during AI processing.

---

# 71. BACKGROUND PROCESSING

Long-running operations:

- Document parsing
- Embeddings
- Legal review
- Export generation
- Large imports
- Weekly brief generation

Store job state:

```ts
interface Job {
  id: string;

  businessId: string;

  type: string;

  status:
    | "queued"
    | "running"
    | "completed"
    | "failed";

  progress?: number;

  createdAt: Timestamp;
  completedAt?: Timestamp;
}
```

---

# 72. RETRY STRATEGY

External APIs should use:

- Exponential backoff
- Maximum retry count
- Idempotency

Stripe webhooks must be idempotent.

Document processing jobs should be safe to retry.

---

# 73. FEATURE FLAGS

Add feature flags early.

Examples:

```text
crm_enabled
finance_connections_enabled
marketing_enabled
automations_enabled
business_collaboration_enabled
```

Admin should eventually control rollout.

---

# 74. FEEDBACK SYSTEM

Global feedback button.

Allow:

- Bug
- Feature request
- Confusing
- Other

Capture:

- Page
- User
- Business
- Browser metadata
- Optional screenshot later

Do not capture confidential document contents automatically.

---

# 75. MVP PHASES

Do not attempt full product in one release.

## PHASE 0 — Foundation

Build:

- Next.js project
- UI system
- Firebase
- Auth
- User model
- Business model
- Membership model
- Onboarding
- Protected routes
- Admin role
- Error monitoring
- Analytics

Acceptance:

A user can sign up, create a business, complete onboarding, and enter the app.

---

## PHASE 1 — Core Dashboard

Build:

- Dashboard
- Business profile
- Tasks
- Notifications
- Business selector
- Settings

Acceptance:

Dashboard is personalized to the selected business.

---

## PHASE 2 — Document Vault

Build:

- Upload
- Storage
- Metadata
- Categories
- Search
- Text extraction
- Processing status
- Document detail view
- AI summary

Acceptance:

User can upload documents and retrieve them securely.

---

## PHASE 3 — LegalAI

Build:

- Legal review
- Structured output
- Risk/attention items
- Key terms
- Missing clauses
- Suggested questions
- Clause rewrite
- Legal review history

Acceptance:

User can upload a business contract and receive a structured review tied to that document.

---

## PHASE 4 — Founder AI

Build:

- Chat UI
- Conversation storage
- Business context
- Tool calling
- Document search
- Dashboard recommendations

Acceptance:

The assistant can answer questions using the user's business profile and uploaded documents.

---

## PHASE 5 — Compliance

Build:

- Compliance rules
- Compliance items
- Deadlines
- Recurring reminders
- Sources
- Admin rules editor

Acceptance:

The platform generates relevant compliance checklist items from business onboarding information.

---

## PHASE 6 — Business Health

Build:

- Health categories
- Health rule engine
- Statuses
- Dashboard integration
- Recommendations

Acceptance:

User can see missing business infrastructure and take action from each item.

---

## PHASE 7 — Finance Tools

Build:

- Runway calculator
- Break-even calculator
- Pricing calculator
- Contractor/employee cost comparison
- Tax reserve estimator

Acceptance:

Finance tools save calculations to the business account.

---

## PHASE 8 — Billing

Build:

- Stripe
- Plans
- Checkout
- Portal
- Trials
- Usage limits
- Upgrade prompts

Acceptance:

Users can upgrade and application permissions react to subscription status.

---

## PHASE 9 — Production Hardening

Build:

- E2E tests
- Rate limits
- Security review
- Audit logs
- Privacy controls
- Account deletion
- Data export
- Monitoring
- Backup plan

---

# 76. POST-MVP ROADMAP

Recommended order:

1. SOP builder
2. Google Drive
3. Gmail
4. Google Calendar
5. CRM
6. Stripe business data integration
7. Financial account integrations
8. QuickBooks
9. Accountant collaboration
10. Attorney collaboration
11. Workflow automations
12. Team permissions
13. Mobile app

---

# 77. FIRST-RUN EXPERIENCE

After onboarding, show:

```text
Welcome to FounderOS.

We created your business workspace.

Here are the first things we recommend:

1. Upload your main customer agreement
2. Review your business health
3. Confirm your compliance checklist
4. Ask FounderOS what to work on next
```

Provide buttons.

---

# 78. EMPTY STATES

Every section needs useful empty states.

Example Documents:

> Your business documents live here.

> Upload contracts, formation records, policies, and other files so FounderOS can organize and understand them.

Button:

```text
Upload your first document
```

LegalAI:

> Upload a contract and FounderOS can summarize it, flag areas that may deserve review, and help prepare questions for your lawyer.

---

# 79. SAMPLE DASHBOARD

```text
Good morning, Alex.

3 items may need your attention.

ATTENTION

[!] Annual report
Due in 28 days

[!] Contractor agreement
2 areas marked for review

[!] Privacy policy
No active document detected


BUSINESS HEALTH

Legal          Needs attention
Compliance     Needs attention
Finance        In progress
Operations     In progress
Sales          Not configured
Security       In progress


UPCOMING

Oct 18     Insurance renewal
Oct 30     Quarterly tax reminder
Nov 1      Contractor review


ASK FOUNDEROS

"What should I focus on this week?"
```

---

# 80. SEARCH ENGINE OPTIMIZATION

Marketing pages to create:

```text
/legal-ai
/contract-review
/business-startup-checklist
/business-health-check
/runway-calculator
/break-even-calculator
/pricing-calculator
/nda-generator
/contractor-agreement
/sop-generator
```

Free tools can be acquisition funnels.

Example:

```text
Free Runway Calculator

→ calculate anonymously

→ "Save this calculation and monitor your runway"
→ signup
```

---

# 81. LEAD GENERATION STRATEGY

Use free utilities to bring users in:

- Contract checker
- Startup checklist
- Runway calculator
- Pricing calculator
- NDA builder
- Business Health questionnaire

The free utility should naturally lead to the platform.

Example:

```text
Contract review complete.

FounderOS detected:
3 items worth reviewing
2 missing provisions

Create a free account to:
Save your review
Ask follow-up questions
Store the contract
Track future versions
```

Avoid artificially hiding all useful results behind signup.

---

# 82. VIRAL / SHARING LOOP

Possible:

Business Health report can be shared.

Example:

```text
Your business setup checklist

Legal          4 / 6
Operations     5 / 8
Finance        3 / 5
Security       2 / 6
```

Avoid turning this into a misleading quality score.

---

# 83. REFERRAL PROGRAM — FUTURE

Potential:

```text
Invite a founder
→ they receive 1 free month
→ referrer receives 1 free month
```

Implement only after validating retention.

---

# 84. DATA MODEL VERSIONING

Schemas will change.

Add:

```text
schemaVersion
```

where appropriate.

Migration scripts should be stored in:

```text
/scripts/migrations
```

Never silently mutate production data in frontend code.

---

# 85. DEVELOPMENT RULES FOR CLAUDE CODE

Claude Code must follow these rules throughout the project.

## Rule 1

Do not implement fake placeholders that appear functional.

If a feature is not built, label it clearly.

## Rule 2

Do not hard-code secrets.

## Rule 3

Do not bypass authentication for convenience.

## Rule 4

Do not leave Firebase development security rules in production.

## Rule 5

Every business-owned resource must be tenant-isolated.

## Rule 6

Validate user input server-side.

## Rule 7

Validate AI structured output.

## Rule 8

Use reusable services.

Do not scatter AI calls throughout UI components.

## Rule 9

Use TypeScript strict mode.

## Rule 10

Keep components reasonably small.

## Rule 11

Prefer server-side authorization.

## Rule 12

Document major architecture decisions.

---

# 86. ARCHITECTURE DOCUMENTATION

Create:

```text
/docs/
├── ARCHITECTURE.md
├── DATABASE.md
├── AI_SYSTEM.md
├── LEGAL_AI.md
├── COMPLIANCE.md
├── SECURITY.md
├── BILLING.md
├── INTEGRATIONS.md
├── DEPLOYMENT.md
└── DEVELOPMENT.md
```

---

# 87. CLAUDE.md

Create a root `CLAUDE.md` containing:

- Product overview
- Tech stack
- Architecture rules
- Important directories
- Database conventions
- Security rules
- Testing commands
- Deployment process
- Coding standards

Claude Code must update `CLAUDE.md` when important architecture changes are made.

---

# 88. README

README should include:

- Product overview
- Local setup
- Environment variables
- Firebase setup
- Stripe setup
- AI provider setup
- Development commands
- Testing
- Deployment

---

# 89. LOCAL DEVELOPMENT

Target commands:

```bash
npm install

npm run dev

npm run lint

npm run typecheck

npm test

npm run test:e2e

npm run build
```

All commands should work before major milestones are considered complete.

---

# 90. CI/CD

GitHub Actions recommended.

On pull request:

```text
Install
Lint
Typecheck
Unit tests
Build
```

Optional:

```text
E2E tests
```

Production deployments only after checks pass.

---

# 91. DEPLOYMENT

Recommended MVP:

Frontend/backend:

- Vercel

Firebase:

- Firebase Auth
- Firestore
- Storage

Domain:

- Custom domain

Configure:

- Development
- Preview
- Production

Use separate Firebase projects for development and production if possible.

---

# 92. BACKUPS

Document backup requirements.

At minimum:

- Firestore backup strategy
- Storage backup strategy
- Source control
- Configuration backup

Future business-tier requirement:

- disaster recovery documentation

---

# 93. TERMS / PRIVACY PAGES

Marketing site must include:

- Terms of Service
- Privacy Policy
- AI disclosure
- Cookie notice if applicable

The generated product's own legal documents should eventually receive professional review before launch.

---

# 94. SECURITY PAGE

Create:

```text
/security
```

Explain:

- Encryption
- Authentication
- Access controls
- Data isolation
- Security reporting contact

Do not claim certifications not obtained.

Avoid:

```text
HIPAA compliant
SOC 2 compliant
PCI compliant
```

unless actually applicable and verified.

---

# 95. TRUST CENTER — FUTURE

Later provide:

- Security documentation
- Subprocessors
- Data retention
- Incident response
- Compliance reports

Important for business customers.

---

# 96. ADMIN AI COST DASHBOARD

Track AI cost by:

- Provider
- Model
- Feature
- Business
- User
- Day
- Month

Metrics:

```text
Requests
Input tokens
Output tokens
Estimated cost
Revenue per user
AI cost as % revenue
```

This is critical for margins.

---

# 97. PRODUCT METRICS

Key SaaS metrics:

- Signup → onboarding completion
- Onboarding → first document
- First document → LegalAI review
- First LegalAI review → second session
- Free → paid conversion
- Trial → paid
- Weekly active businesses
- Monthly active businesses
- Churn
- MRR
- ARPU

Important activation metric:

> User receives useful business-specific insight within their first session.

---

# 98. CORE USER JOURNEY

Ideal journey:

```text
Visitor
↓
Uses free contract checker
↓
Sees useful review
↓
Creates account
↓
Adds business
↓
Contract saved to vault
↓
Business Health detects missing items
↓
Founder AI explains next steps
↓
User creates compliance reminders
↓
User returns because FounderOS now contains business context
↓
Paid subscription
```

---

# 99. MOAT

The moat is not the AI model.

The moat is accumulated structured business context:

```text
Company profile
+
Documents
+
Compliance state
+
Processes
+
Financial context
+
Customer relationships
+
Task history
+
AI memory
+
Integrations
```

The more the user uses FounderOS, the more useful it becomes.

Design the data model around this principle.

---

# 100. PRODUCT PRINCIPLE

Every major feature should answer one of these questions:

```text
What does this mean?

What am I missing?

What should I do next?

Where is that document?

What is happening in my business?

How do I complete this?

What should I prepare before talking to a professional?
```

If a feature cannot answer one of those questions or meaningfully support the workflow, reconsider whether it belongs in the product.

---

# 101. MVP DEFINITION OF DONE

The initial sellable MVP is complete when a new user can:

1. Create an account.
2. Create a business.
3. Complete business onboarding.
4. See a personalized dashboard.
5. Upload documents.
6. Search documents.
7. Run LegalAI reviews.
8. Ask questions about uploaded documents.
9. Use Founder AI with business context.
10. View a personalized compliance checklist.
11. Track deadlines.
12. View Business Health.
13. Create tasks.
14. Use core finance calculators.
15. Subscribe through Stripe.
16. Manage subscription.
17. Delete/export account data.
18. Receive relevant email reminders.
19. Use the core product on desktop and mobile.
20. Have all tenant data securely isolated.

Do not delay MVP for CRM, marketing automation, advanced accounting, or a native mobile app.

---

# 102. FIRST CLAUDE CODE TASKS

Claude Code should execute the project in this order.

## Task 1

Initialize repository and Next.js application.

Configure:

- TypeScript strict
- Tailwind
- shadcn
- ESLint
- Prettier
- environment management

## Task 2

Create architecture documentation and `CLAUDE.md`.

## Task 3

Implement Firebase:

- Auth
- Firestore
- Storage
- Admin SDK

## Task 4

Implement:

- User
- Business
- Membership
- Permissions

## Task 5

Build onboarding.

## Task 6

Build application shell:

- Sidebar
- Header
- Business switcher
- Dashboard

## Task 7

Build Document Vault.

## Task 8

Build document-processing pipeline.

## Task 9

Build AI provider abstraction.

## Task 10

Build LegalAI.

## Task 11

Build RAG.

## Task 12

Build Founder AI and tool calling.

## Task 13

Build Compliance Rules engine.

## Task 14

Build Business Health.

## Task 15

Build finance calculators.

## Task 16

Build Stripe billing.

## Task 17

Build notifications.

## Task 18

Build admin portal.

## Task 19

Add analytics and monitoring.

## Task 20

Perform production security hardening and testing.

---

# 103. CLAUDE CODE EXECUTION INSTRUCTIONS

When beginning development:

1. Read this entire specification.
2. Generate a proposed repository architecture.
3. Create `/docs/ARCHITECTURE.md`.
4. Create `CLAUDE.md`.
5. Create a phase checklist in `/docs/ROADMAP.md`.
6. Implement only the current phase.
7. Test that phase.
8. Update documentation.
9. Commit or produce a concise implementation summary.
10. Continue to the next phase.

Do not attempt to generate the entire application in a single uncontrolled pass.

For each phase:

```text
PLAN
↓
IMPLEMENT
↓
TEST
↓
FIX
↓
DOCUMENT
↓
NEXT PHASE
```

---

# 104. IMPORTANT PRODUCT DECISIONS TO PRESERVE

- LegalAI is an assistance/preparation tool, not a lawyer replacement.
- Founder AI is the long-term product centerpiece.
- Business Health answers "what am I forgetting?"
- The app is designed for real small businesses, not only Silicon Valley startups.
- The dashboard should surface action rather than vanity metrics.
- Company context is the long-term moat.
- Integrations should eventually make the AI proactive.
- User trust and security matter because business documents may be confidential.
- Avoid becoming a bloated toolbox.
- Each feature should tie back into the centralized Business Context system.

---

# 105. FINAL PRODUCT VISION

The final product should eventually be capable of the following interaction:

User:

> What should I work on this week?

FounderOS:

> Based on your business workspace, I would look at these items:
>
> - Your annual business filing is coming up.
> - Your contractor agreement has two clauses you previously marked for review.
> - Three invoices are still outstanding.
> - Your estimated cash runway declined this month.
> - Your employee onboarding SOP is incomplete.
>
> I can help you handle any of these from here.

That experience is the north star.

FounderOS should evolve from:

```text
A toolbox
```

into:

```text
A business operating system that understands the company.
```

---

# END OF SPECIFICATION
