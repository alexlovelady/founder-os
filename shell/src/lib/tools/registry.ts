import type { ToolDef } from "@founderos/sdk";
import { tool as finance } from "@founderos/finance";
import { tool as compliance } from "@founderos/compliance";
import { tool as health } from "@founderos/health";
import { tool as tasks } from "@founderos/tasks";
import { tool as vault } from "@founderos/vault";
import { tool as sops } from "@founderos/sops";
import { tool as crm } from "@founderos/crm";
import { tool as marketing } from "@founderos/marketing";
import { tool as founderai } from "@founderos/founderai";
import { tool as product } from "@founderos/product";
import { tool as competitors } from "@founderos/competitors";

/** Every tool in the product. Adding a tool = a folder under /modules, a workspace entry, and one line here. */
export const TOOLS: ToolDef[] = [finance, compliance, health, tasks, vault, sops, crm, marketing, founderai, product, competitors];

export const getTool = (id: string) => TOOLS.find((t) => t.id === id);
