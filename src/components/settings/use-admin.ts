import { useEffect, useState } from "react";
import { useRuntime } from "@/lib/runtime/store";

/** Whether the signed-in user is an instance administrator. Hidden until the server confirms. */
export function useIsAdmin(): boolean {
    const { client } = useRuntime();
    const [admin, setAdmin] = useState(false);
    useEffect(() => {
        let live = true;
        setAdmin(false);
        client?.myRole().then((role) => live && setAdmin(role === "admin")).catch(() => undefined);
        return () => {
            live = false;
        };
    }, [client]);
    return admin;
}
