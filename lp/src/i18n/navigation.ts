import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

// Plain next/link does not update the stored locale, so a switch would flip straight back.
export const { Link, redirect, usePathname, useRouter } = createNavigation(routing);
