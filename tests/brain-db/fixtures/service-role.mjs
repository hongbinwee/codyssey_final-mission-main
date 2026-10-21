import {randomBytes} from "node:crypto";
import {BRAIN_SERVICE_RIGHTS} from "../../../src/brain/runtime.ts";

/** CI provisioning only: never grant rights on a development or QA service DB. */
export async function provisionBrainCiService(admin, adminUrl) {
 const url=new URL(adminUrl);
 if(url.pathname!=="/brain_ci")throw Error("disposable brain_ci required");
 const [identity]=await admin.unsafe("SELECT current_database() AS name");
 if(identity?.name!=="brain_ci")throw Error("disposable brain_ci identity mismatch");
 const role="brain_ci_service_"+randomBytes(8).toString("hex");
 const password=randomBytes(24).toString("hex");
 // Identifiers/password consist only of fixed ASCII prefixes and generated hex.
 await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
 await admin.unsafe(`GRANT CONNECT ON DATABASE brain_ci TO ${role}`);
 await admin.unsafe(`GRANT USAGE ON SCHEMA shopping_brain TO ${role}`);
 for(const [table,rights] of Object.entries(BRAIN_SERVICE_RIGHTS))
  await admin.unsafe(`GRANT ${rights.join(",")} ON TABLE shopping_brain.${table} TO ${role}`);
 url.username=role;url.password=password;
 return url.toString();
}
