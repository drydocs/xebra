import type { WrapperState } from "../../lib/admin/chain";
import type { AdminCall } from "../../lib/admin/chain";
import type { Role } from "../../lib/admin/policy";

/** A change waiting for the operator's explicit go-ahead before the wallet is asked to sign. */
export interface ChangeRequest {
  call: AdminCall;
  title: string;
  /** Plain lines shown in the confirmation: exactly what will be sent. */
  detail: string[];
  danger?: boolean;
}

export interface PanelProps {
  state: WrapperState;
  role: Role;
  busy: boolean;
  request: (req: ChangeRequest) => void;
  signer: string | null;
}
