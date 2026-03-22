/**
 * Seed the CNPD database with sample decisions and guidelines for testing.
 *
 * Includes real CNPD decisions (Amazon EUR 746M, payment processor breach)
 * and representative guidance documents so MCP tools can be tested without
 * running a full data ingestion pipeline.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["CNPD_LU_DB_PATH"] ?? "data/cnpd_lu.db";
const force = process.argv.includes("--force");

// --- Bootstrap database ------------------------------------------------------

const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

if (force && existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`Deleted existing database at ${DB_PATH}`);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);

console.log(`Database initialised at ${DB_PATH}`);

// --- Topics ------------------------------------------------------------------

interface TopicRow {
  id: string;
  name_fr: string;
  name_en: string;
  description: string;
}

const topics: TopicRow[] = [
  {
    id: "sous_traitance",
    name_fr: "Sous-traitance",
    name_en: "Data processing on behalf",
    description: "Obligations des sous-traitants et des responsables du traitement dans les relations de sous-traitance (art. 28 RGPD).",
  },
  {
    id: "vidéosurveillance",
    name_fr: "Vidéosurveillance",
    name_en: "Video surveillance",
    description: "Utilisation de caméras de surveillance dans les lieux publics et privés.",
  },
  {
    id: "cookies",
    name_fr: "Cookies et traceurs",
    name_en: "Cookies and trackers",
    description: "Dépôt et lecture de cookies et traceurs sur les terminaux des utilisateurs.",
  },
  {
    id: "transferts",
    name_fr: "Transferts internationaux",
    name_en: "International transfers",
    description: "Transferts de données personnelles vers des pays tiers (art. 44–49 RGPD).",
  },
  {
    id: "consentement",
    name_fr: "Consentement",
    name_en: "Consent",
    description: "Conditions de validité du consentement comme base juridique (art. 7 RGPD).",
  },
  {
    id: "analyse_impact",
    name_fr: "Analyse d'impact (AIPD)",
    name_en: "Data Protection Impact Assessment",
    description: "Analyse d'impact relative à la protection des données pour les traitements à risque élevé (art. 35 RGPD).",
  },
  {
    id: "droit_acces",
    name_fr: "Droit d'accès",
    name_en: "Right of access",
    description: "Droit des personnes concernées d'obtenir accès à leurs données (art. 15 RGPD).",
  },
  {
    id: "violation_donnees",
    name_fr: "Violation de données",
    name_en: "Data breach",
    description: "Notification des violations de données personnelles à la CNPD et aux personnes concernées (art. 33–34 RGPD).",
  },
  {
    id: "secteur_financier",
    name_fr: "Secteur financier",
    name_en: "Financial sector",
    description: "Traitement des données personnelles dans le secteur financier (banques, assurances, fonds d'investissement) au Luxembourg.",
  },
];

const insertTopic = db.prepare(
  "INSERT OR IGNORE INTO topics (id, name_fr, name_en, description) VALUES (?, ?, ?, ?)",
);

for (const t of topics) {
  insertTopic.run(t.id, t.name_fr, t.name_en, t.description);
}

console.log(`Inserted ${topics.length} topics`);

// --- Decisions ---------------------------------------------------------------

interface DecisionRow {
  reference: string;
  title: string;
  date: string;
  type: string;
  entity_name: string;
  fine_amount: number | null;
  summary: string;
  full_text: string;
  topics: string;
  gdpr_articles: string;
  status: string;
}

const decisions: DecisionRow[] = [
  // Amazon Europe — EUR 746M (largest GDPR fine ever at the time)
  {
    reference: "CNPD-DEC-2021-AZ-001",
    title: "Délibération CNPD — Amazon Europe Core S.à r.l. (746 millions EUR)",
    date: "2021-07-16",
    type: "sanction",
    entity_name: "Amazon Europe Core S.à r.l.",
    fine_amount: 746_000_000,
    summary:
      "La CNPD a infligé à Amazon Europe Core S.à r.l. une amende de 746 millions d'euros, la plus grande amende RGPD jamais prononcée, pour traitement de données personnelles à des fins publicitaires sans base légale valable. Amazon Europe est établie au Luxembourg et constitue le point central de l'établissement principal d'Amazon dans l'Union européenne.",
    full_text:
      "La Commission Nationale pour la Protection des Données (CNPD) du Luxembourg a prononcé une amende de 746 millions d'euros à l'encontre d'Amazon Europe Core S.à r.l., établie au Luxembourg. Cette décision a été prise à l'issue d'une procédure de coopération entre les autorités de protection des données de l'UE, conformément au mécanisme du guichet unique prévu par le RGPD. La procédure a été initiée par une plainte collective déposée par La Quadrature du Net (LQDN) en France en 2018, regroupant plusieurs dizaines de milliers de plaignants. La CNPD, en tant qu'autorité de contrôle chef de file d'Amazon dans l'UE, a conduit l'enquête. Les constatations principales sont les suivantes: (1) Absence de base légale valable — Amazon a traité les données personnelles des utilisateurs européens à des fins publicitaires (ciblage publicitaire, personnalisation) sans base légale valable au sens de l'art. 6 RGPD; l'argument du consentement était insuffisant car le consentement recueilli par Amazon ne remplissait pas les critères de libre, spécifique, éclairé et univoque; l'argument de l'intérêt légitime était écarté car les intérêts des utilisateurs prévalent sur les intérêts commerciaux d'Amazon; (2) Non-respect des principes fondamentaux — la collecte et l'utilisation massives de données de comportement des utilisateurs à des fins de profilage publicitaire ne respectent pas les principes de minimisation des données (art. 5(1)(c)) et de limitation des finalités (art. 5(1)(b)). Amazon a contesté la décision devant les juridictions luxembourgeoises. Cette affaire illustre le rôle central du Luxembourg comme État membre d'établissement de nombreuses grandes entreprises technologiques américaines.",
    topics: JSON.stringify(["consentement", "transferts", "sous_traitance"]),
    gdpr_articles: JSON.stringify(["5", "6", "7"]),
    status: "final",
  },
  // Payment processor data breach
  {
    reference: "CNPD-DEC-2023-PY-001",
    title: "Délibération CNPD — Prestataire de paiement (violation de données)",
    date: "2023-04-18",
    type: "sanction",
    entity_name: "Prestataire de paiement (anonymisé)",
    fine_amount: 240_000,
    summary:
      "La CNPD a sanctionné un prestataire de services de paiement établi au Luxembourg pour une violation de données ayant exposé les informations bancaires de clients. La notification tardive à la CNPD et l'insuffisance des mesures de sécurité ont été retenues à charge.",
    full_text:
      "La Commission Nationale pour la Protection des Données a prononcé une amende de 240.000 euros à l'encontre d'un prestataire de services de paiement établi au Luxembourg. Ce prestataire, qui traite des paiements pour le compte de commerçants en ligne opérant dans plusieurs États membres de l'UE, a subi une cyberattaque ayant conduit à l'exfiltration des données bancaires (numéros de cartes de paiement, dates d'expiration, noms des titulaires) de plusieurs dizaines de milliers de clients. La CNPD a constaté les manquements suivants: (1) Violation de l'art. 32 RGPD — les mesures de sécurité mises en place par le prestataire n'étaient pas suffisantes compte tenu du niveau de risque inhérent au traitement de données de paiement; des vulnérabilités connues dans le système de traitement des paiements n'avaient pas été corrigées dans les délais recommandés par les éditeurs de logiciels; le chiffrement des données de cartes au repos était insuffisant; (2) Violation de l'art. 33 RGPD — la violation de données a été notifiée à la CNPD avec un retard de 11 jours par rapport à la détection interne de l'incident, alors que le délai réglementaire est de 72 heures; (3) Insuffisance des notifications aux personnes concernées — les clients affectés n'ont pas été informés dans des délais raisonnables et les informations fournies étaient insuffisamment claires sur les risques concrets pour eux. Le secteur financier luxembourgeois traite des volumes importants de données de paiement en raison de la présence de nombreux établissements bancaires et de paiement au Luxembourg.",
    topics: JSON.stringify(["violation_donnees", "secteur_financier"]),
    gdpr_articles: JSON.stringify(["32", "33", "34"]),
    status: "final",
  },
  // Right of access — financial sector
  {
    reference: "CNPD-DEC-2022-BK-001",
    title: "Délibération CNPD — Établissement bancaire (refus de droit d'accès)",
    date: "2022-11-22",
    type: "sanction",
    entity_name: "Établissement bancaire (anonymisé)",
    fine_amount: 75_000,
    summary:
      "La CNPD a sanctionné un établissement bancaire luxembourgeois pour avoir refusé de répondre à une demande d'accès aux données personnelles d'un client. L'établissement avait invoqué le secret bancaire de manière abusive pour justifier le refus. La CNPD a rappelé que le secret bancaire ne fait pas obstacle au droit d'accès RGPD.",
    full_text:
      "La Commission Nationale pour la Protection des Données a infligé une amende de 75.000 euros à un établissement bancaire établi au Luxembourg. Un client de cet établissement avait présenté une demande d'accès à ses données personnelles conformément à l'art. 15 du RGPD. L'établissement bancaire avait refusé de donner suite à cette demande en invoquant le secret bancaire luxembourgeois. La CNPD a rejeté cet argument et constaté les manquements suivants: (1) Violation du droit d'accès (art. 15 RGPD) — le secret bancaire ne saurait constituer un motif valable de refus d'une demande d'accès formulée par la personne concernée elle-même, qui est précisément le bénéficiaire de la protection offerte par le secret bancaire; la personne concernée a le droit d'accéder à l'ensemble des données la concernant, y compris les données bancaires; (2) Non-respect du délai de réponse (art. 12 RGPD) — même si l'établissement avait pu invoquer une exception, il aurait dû répondre dans le délai d'un mois en précisant les motifs du refus et en informant la personne de son droit de saisir la CNPD; (3) Absence de traçabilité interne — l'établissement n'était pas en mesure de démontrer qu'il disposait de procédures internes pour traiter les demandes de droits des personnes concernées.",
    topics: JSON.stringify(["droit_acces", "secteur_financier"]),
    gdpr_articles: JSON.stringify(["12", "15"]),
    status: "final",
  },
];

const insertDecision = db.prepare(`
  INSERT OR IGNORE INTO decisions
    (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertDecisionsAll = db.transaction(() => {
  for (const d of decisions) {
    insertDecision.run(
      d.reference,
      d.title,
      d.date,
      d.type,
      d.entity_name,
      d.fine_amount,
      d.summary,
      d.full_text,
      d.topics,
      d.gdpr_articles,
      d.status,
    );
  }
});

insertDecisionsAll();
console.log(`Inserted ${decisions.length} decisions`);

// --- Guidelines --------------------------------------------------------------

interface GuidelineRow {
  reference: string | null;
  title: string;
  date: string;
  type: string;
  summary: string;
  full_text: string;
  topics: string;
  language: string;
}

const guidelines: GuidelineRow[] = [
  {
    reference: "CNPD-GUIDE-VIDEO-2021",
    title: "Guide pratique — Vidéosurveillance au Luxembourg",
    date: "2021-03-15",
    type: "guide",
    summary:
      "Guide pratique de la CNPD sur les conditions d'installation et d'utilisation de systèmes de vidéosurveillance au Luxembourg. Traite des bases légales, des obligations d'information, des durées de conservation et des obligations spécifiques pour les établissements financiers.",
    full_text:
      "Ce guide pratique de la Commission Nationale pour la Protection des Données expose les règles applicables à la vidéosurveillance au Luxembourg. La vidéosurveillance au Luxembourg est soumise à la loi du 25 mars 2015 (dite 'Caméra loi') et au RGPD. Base légale: La vidéosurveillance peut être fondée sur l'intérêt légitime (art. 6(1)(f) RGPD) lorsque les raisons de sécurité prévalent sur les intérêts des personnes filmées, ou sur une obligation légale pour certains secteurs réglementés (art. 6(1)(c) RGPD). Obligation d'information: Les zones surveillées doivent être signalées par un pictogramme visible avant l'entrée dans la zone. Ce pictogramme doit contenir: l'identité du responsable du traitement, les finalités de la surveillance, la durée de conservation des enregistrements et les droits des personnes. Durée de conservation: Les enregistrements ne peuvent être conservés plus de 30 jours, sauf procédure judiciaire ou administrative en cours. Accès aux images: L'accès aux enregistrements est strictement limité aux personnes habilitées par le responsable du traitement. Secteur financier: Les établissements financiers soumis à des exigences réglementaires spécifiques (banques, assurances) peuvent être tenus de conserver les enregistrements plus longtemps en vertu de la réglementation sectorielle.",
    topics: JSON.stringify(["vidéosurveillance", "secteur_financier"]),
    language: "fr",
  },
  {
    reference: "CNPD-GUIDE-COOKIES-2021",
    title: "Guide pratique — Cookies et autres traceurs",
    date: "2021-06-01",
    type: "guide",
    summary:
      "Guide pratique de la CNPD sur les obligations relatives aux cookies et autres traceurs au Luxembourg. Précise les conditions de validité du consentement, les catégories de cookies exemptés, les exigences des bandeaux cookies et les durées maximales de conservation.",
    full_text:
      "La Commission Nationale pour la Protection des Données publie ce guide pratique pour aider les responsables du traitement établis au Luxembourg à se mettre en conformité avec les règles relatives aux cookies et autres traceurs. Base légale: Conformément à la loi du 28 juillet 2011 relative à la protection des personnes à l'égard du traitement des données à caractère personnel (modifiée), les cookies et traceurs non indispensables au fonctionnement du service requièrent le consentement préalable de l'utilisateur. Consentement valide: Le consentement doit être: libre (pas de cookie wall sauf exception justifiée), spécifique (par finalité), éclairé (information claire et accessible) et univoque (action positive). Cookies exemptés de consentement: Certains cookies ne nécessitent pas de consentement préalable: cookies de session d'authentification, cookies de panier d'achat, cookies de mesure d'audience (strictement limités), cookies nécessaires à la sécurité. Bandeaux cookies: Le bandeau doit proposer un moyen de refuser les cookies aussi simple que d'accepter. Un bouton 'Refuser tout' doit être proposé au même niveau que 'Accepter tout'. Durée de conservation du consentement: Le consentement pour les cookies a une durée de validité maximale de 13 mois, après quoi il doit être renouvelé.",
    topics: JSON.stringify(["cookies", "consentement"]),
    language: "fr",
  },
  {
    reference: "CNPD-GUIDE-SOUSTRAITANT-2020",
    title: "Guide pratique — Obligations du sous-traitant (art. 28 RGPD)",
    date: "2020-11-01",
    type: "guide",
    summary:
      "Guide pratique de la CNPD sur les obligations des sous-traitants au Luxembourg dans le cadre du RGPD. Traite du contenu obligatoire des contrats de sous-traitance, de la chaîne de responsabilité, des sous-sous-traitants et des obligations de sécurité spécifiques aux sous-traitants.",
    full_text:
      "Le Luxembourg accueille de nombreuses sociétés opérant comme sous-traitants de données au sens de l'art. 28 RGPD. Ce guide de la CNPD précise les obligations qui incombent à ces entités. Définition: Un sous-traitant est une personne physique ou morale qui traite des données personnelles pour le compte du responsable du traitement. Contrat de sous-traitance obligatoire: Tout traitement effectué par un sous-traitant doit être encadré par un contrat écrit (art. 28(3) RGPD). Ce contrat doit notamment: définir la nature, la durée, les finalités et les catégories de données traitées; prévoir que le sous-traitant ne traite les données que sur instruction documentée du responsable; garantir la confidentialité des données; prévoir des mesures de sécurité adéquates; autoriser ou interdire le recours à des sous-sous-traitants; aider le responsable à répondre aux demandes d'exercice de droits; prévoir des dispositions de retour ou de destruction des données à l'issue du contrat. Sous-sous-traitants: Le recours à un sous-sous-traitant requiert l'autorisation préalable du responsable du traitement. Le sous-traitant principal reste responsable des manquements du sous-sous-traitant. Secteur financier: Les sous-traitants fournissant des services à des établissements financiers luxembourgeois doivent en outre satisfaire aux exigences de la CSSF (Commission de Surveillance du Secteur Financier) en matière d'externalisation.",
    topics: JSON.stringify(["sous_traitance", "secteur_financier"]),
    language: "fr",
  },
];

const insertGuideline = db.prepare(`
  INSERT INTO guidelines (reference, title, date, type, summary, full_text, topics, language)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertGuidelinesAll = db.transaction(() => {
  for (const g of guidelines) {
    insertGuideline.run(
      g.reference,
      g.title,
      g.date,
      g.type,
      g.summary,
      g.full_text,
      g.topics,
      g.language,
    );
  }
});

insertGuidelinesAll();
console.log(`Inserted ${guidelines.length} guidelines`);

// --- Summary -----------------------------------------------------------------

const decisionCount = (
  db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }
).cnt;
const guidelineCount = (
  db.prepare("SELECT count(*) as cnt FROM guidelines").get() as { cnt: number }
).cnt;
const topicCount = (
  db.prepare("SELECT count(*) as cnt FROM topics").get() as { cnt: number }
).cnt;
const decisionFtsCount = (
  db.prepare("SELECT count(*) as cnt FROM decisions_fts").get() as { cnt: number }
).cnt;
const guidelineFtsCount = (
  db.prepare("SELECT count(*) as cnt FROM guidelines_fts").get() as { cnt: number }
).cnt;

console.log(`\nDatabase summary:`);
console.log(`  Topics:         ${topicCount}`);
console.log(`  Decisions:      ${decisionCount} (FTS entries: ${decisionFtsCount})`);
console.log(`  Guidelines:     ${guidelineCount} (FTS entries: ${guidelineFtsCount})`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();
