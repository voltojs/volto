import { createMemoryStore } from "../index.js";
import { runStoreContractTests } from "@agent-core/core/testing";

runStoreContractTests(() => createMemoryStore());
