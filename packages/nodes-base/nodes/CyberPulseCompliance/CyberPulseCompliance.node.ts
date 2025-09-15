import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';

type Clause = { framework: string; clause: string; title: string };
type Crosswalk = Record<string, Record<string, Clause[]>>;

/** Built-in minimal crosswalk (short labels only; safe to ship) */
const DEFAULT_CROSSWALK: Crosswalk = {
	mfa: {
		'ISO 27001': [{ clause: 'A.5.17', title: 'Authentication information', framework: 'ISO 27001' }],
		'SOC 2': [{ clause: 'CC6.1', title: 'Logical access controls', framework: 'SOC 2' }],
		'NIST CSF': [{ clause: 'PR.AC-1', title: 'Identities managed', framework: 'NIST CSF' }],
		'PCI DSS': [{ clause: '8.4', title: 'Multi-factor authentication', framework: 'PCI DSS' }],
		'Essential Eight': [{ clause: 'AC', title: 'Access control (maturity)', framework: 'Essential Eight' }],
		GDPR: [{ clause: 'Art. 32', title: 'Security of processing (access control)', framework: 'GDPR' }],
	},
	encryption: {
		'ISO 27001': [{ clause: 'A.8.24', title: 'Cryptography', framework: 'ISO 27001' }],
		'SOC 2': [{ clause: 'CC6.7', title: 'Encryption protections', framework: 'SOC 2' }],
		'NIST CSF': [{ clause: 'PR.DS-1', title: 'Data-at-rest protected', framework: 'NIST CSF' }],
		'PCI DSS': [{ clause: '3.5', title: 'Protect stored account data', framework: 'PCI DSS' }],
		'Essential Eight': [{ clause: 'DM', title: 'Data protection (maturity)', framework: 'Essential Eight' }],
		GDPR: [{ clause: 'Art. 32', title: 'Security of processing (encryption)', framework: 'GDPR' }],
	},
	logging: {
		'ISO 27001': [{ clause: 'A.8.15', title: 'Logging', framework: 'ISO 27001' }],
		'SOC 2': [{ clause: 'CC7.2', title: 'Monitor and detect', framework: 'SOC 2' }],
		'NIST CSF': [{ clause: 'DE.CM-1', title: 'Monitoring for anomalies', framework: 'NIST CSF' }],
		'PCI DSS': [{ clause: '10.2', title: 'Log and monitor all access', framework: 'PCI DSS' }],
		'Essential Eight': [{ clause: 'LM', title: 'Logging & monitoring (maturity)', framework: 'Essential Eight' }],
		GDPR: [{ clause: 'Art. 5(1)(f)', title: 'Integrity and confidentiality', framework: 'GDPR' }],
	},
	backups: {
		'ISO 27001': [{ clause: 'A.8.13', title: 'Backup', framework: 'ISO 27001' }],
		'SOC 2': [{ clause: 'CC7.3', title: 'Resilience and recovery', framework: 'SOC 2' }],
		'NIST CSF': [{ clause: 'PR.IP-4', title: 'Backups maintained and tested', framework: 'NIST CSF' }],
		'PCI DSS': [{ clause: '12.10.4', title: 'Incident response incl. recovery', framework: 'PCI DSS' }],
		'Essential Eight': [{ clause: 'DR', title: 'Backups & recovery (maturity)', framework: 'Essential Eight' }],
		GDPR: [{ clause: 'Art. 32', title: 'Availability and resilience', framework: 'GDPR' }],
	},
	patching: {
		'ISO 27001': [{ clause: 'A.8.8', title: 'Technical vulnerabilities', framework: 'ISO 27001' }],
		'SOC 2': [{ clause: 'CC7.1', title: 'Identify & mitigate vulnerabilities', framework: 'SOC 2' }],
		'NIST CSF': [{ clause: 'PR.IP-12', title: 'Vulnerability management', framework: 'NIST CSF' }],
		'PCI DSS': [{ clause: '6.3', title: 'Security patches', framework: 'PCI DSS' }],
		'Essential Eight': [{ clause: 'PA', title: 'Patch apps/OS (maturity)', framework: 'Essential Eight' }],
		GDPR: [{ clause: 'Art. 25', title: 'Data protection by design/default', framework: 'GDPR' }],
	},
	access_reviews: {
		'ISO 27001': [{ clause: 'A.5.18', title: 'Access rights', framework: 'ISO 27001' }],
		'SOC 2': [{ clause: 'CC6.3', title: 'Provisioning and reviews', framework: 'SOC 2' }],
		'NIST CSF': [{ clause: 'PR.AC-4', title: 'Permissions managed', framework: 'NIST CSF' }],
		'PCI DSS': [{ clause: '7.2', title: 'Access by business need', framework: 'PCI DSS' }],
		'Essential Eight': [{ clause: 'AC', title: 'Least privilege (maturity)', framework: 'Essential Eight' }],
		GDPR: [{ clause: 'Art. 5(1)(c)', title: 'Data minimisation', framework: 'GDPR' }],
	},
};

function classifyCategories(text: string): string[] {
	const t = (text || '').toLowerCase();
	const hits: Set<string> = new Set();
	if (/(mfa|2fa|two[-\s]?factor|multi[-\s]?factor)/.test(t)) hits.add('mfa');
	if (/(encrypt|aes|rsa|kms|tls|https|at rest|at-rest)/.test(t)) hits.add('encryption');
	if (/(log|logging|siem|monitor|edr|xdr|soc)/.test(t)) hits.add('logging');
	if (/(backup|back[-\s]?up|snapshots?|restore|rpo|rto|dr test|disaster recovery)/.test(t)) hits.add('backups');
	if (/(patch|update|vulnerability|cve|scan|remediate)/.test(t)) hits.add('patching');
	if (/(access review|recertif|least privilege|privilege review|entitlement)/.test(t)) hits.add('access_reviews');
	if (hits.size === 0) hits.add('logging');
	return Array.from(hits);
}

function scoreFor(categories: string[], evidenceCount: number): { score: number; status: 'Compliant' | 'Partial' | 'Non-Compliant' } {
	const weights: Record<string, number> = { mfa: 25, encryption: 20, logging: 15, backups: 15, patching: 15, access_reviews: 10 };
	let raw = 0;
	for (const c of categories) raw += weights[c] ?? 0;

	// evidence boost (up to +10)
	const boost = Math.min(evidenceCount * 5, 10);
	let score = Math.min(raw + boost, 100);

	let status: 'Compliant' | 'Partial' | 'Non-Compliant';
	if (score >= 85) status = 'Compliant';
	else if (score >= 60) status = 'Partial';
	else status = 'Non-Compliant';

	return { score, status };
}

export class CyberPulseCompliance implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'CyberPulse Compliance',
		name: 'cyberPulseCompliance',
		group: ['transform'],
		version: 1,
		description: 'Evaluate a control & evidence, map to selected frameworks, and return a score/status.',
		defaults: { name: 'CyberPulse Compliance' },
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main],
		usableAsTool: true,
		properties: [
			{
				displayName: 'Control Text',
				name: 'controlText',
				type: 'string',
				default: '',
				placeholder: 'e.g., Password policy requires MFA and 12+ characters',
				description: 'Your policy/control statement to evaluate',
			},
			{
				displayName: 'Evidence URLs',
				name: 'evidenceUrls',
				type: 'string',
				typeOptions: { multipleValues: true, multipleValueButtonText: 'Add URL' },
				default: [],
				placeholder: 'https://portal.example.com/report.pdf',
				description: 'Links to proofs (dashboards, reports, configs)',
			},
			{
 				displayName: 'Frameworks',
  				name: 'frameworks',
 				type: 'multiOptions',
 				default: ['Essential Eight', 'GDPR', 'ISO 27001', 'NIST CSF', 'PCI DSS', 'SOC 2'],
  				options: [
   					 { name: 'Essential Eight', value: 'essential8' },
   					 { name: 'GDPR', value: 'gdpr' },
  					 { name: 'ISO 27001', value: 'iso27001' },
  					 { name: 'NIST CSF', value: 'nistcsf' },
    					 { name: 'PCI DSS', value: 'pcidss' },
   					 { name: 'SOC 2', value: 'soc2' },
 				 ],
  				 description: 'Frameworks to map against',
			},
			{
				displayName: 'Crosswalk URL',
				name: 'crosswalkUrl',
				type: 'string',
				default: '',
				placeholder: 'http://localhost:8080/crosswalk.json',
				description: 'Optional: URL to JSON crosswalk (overrides built-in)',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const output: INodeExecutionData[] = [];

		// Load crosswalk via n8n HTTP helper if URL provided
		let crosswalk: Crosswalk = DEFAULT_CROSSWALK;
		try {
			const url = (this.getNodeParameter('crosswalkUrl', 0, '') as string) || '';
			if (url) {
				const res = await this.helpers.httpRequest({ method: 'GET', url, json: true });
				if (res) crosswalk = res as Crosswalk;
			}
		} catch {
			// keep DEFAULT_CROSSWALK silently
		}

		for (let i = 0; i < items.length; i++) {
			try {
				const controlText = (this.getNodeParameter('controlText', i, '') as string) || '';
				const evidenceUrls = (this.getNodeParameter('evidenceUrls', i, []) as string[]) || [];
				const frameworks = (this.getNodeParameter('frameworks', i, []) as string[]) || [];

				// 1) classify + score
				const categories = classifyCategories(controlText);
				let { score, status } = scoreFor(categories, evidenceUrls.length);

				// 2) enforce evidence rule: no evidence ⇒ at most Partial + add gap
				const gaps: string[] = [];
				if (evidenceUrls.length === 0) {
					if (status === 'Compliant') status = 'Partial';
					gaps.push('No evidence provided');
				}

				// 3) map requirements (selected frameworks only)
				const mapped: Clause[] = [];
				for (const cat of categories) {
					const fwMap = crosswalk[cat] || {};
					for (const fw of frameworks) {
						const list = fwMap[fw] || [];
						for (const c of list) mapped.push(c);
					}
				}

				// 4) suggested actions
				const actions = [
					...(categories.includes('mfa') ? ['Confirm MFA enforced for all privileged accounts'] : []),
					...(categories.includes('encryption') ? ['Verify encryption at rest & in transit'] : []),
					...(categories.includes('logging') ? ['Forward critical logs to SIEM & alert on anomalies'] : []),
					...(categories.includes('backups') ? ['Test restores to validate RPO/RTO targets'] : []),
					...(categories.includes('patching') ? ['Apply critical patches within policy SLA'] : []),
					...(categories.includes('access_reviews') ? ['Perform quarterly access recertifications'] : []),
					...(evidenceUrls.length === 0 ? ['Attach relevant evidence links'] : []),
				];

				output.push({
					json: {
						input_control_text: controlText,
						categories,
						evidence: evidenceUrls,
						status,
						score,
						mapped_requirements: mapped,
						frameworks_selected: frameworks,
						gaps,
						actions,
						notes: 'Prototype result. Tune keywords, weights, and crosswalk JSON for your org.',
					},
				});
			} catch (error) {
				if (this.continueOnFail()) {
					output.push({ json: items[i]?.json ?? {}, error, pairedItem: i });
				} else {
					if ((error as any).context) {
						(error as any).context.itemIndex = i;
						throw error;
					}
					throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
				}
			}
		}

		return this.prepareOutputData(output);
	}
}
