//! State representation for the model checker — the analog of
//! `tlc2/tool/TLCStateMut`: one `Option<Value>` slot per declared variable,
//! indexed by `VarId`. A state under construction has `None` holes; a frozen
//! (fully specified) state is all-`Some`.

use crate::diag::Diag;
use crate::sem::{Analysis, VarId};
use crate::value::{Value, ValueCtx};

#[derive(Clone, Debug)]
pub struct State {
    pub vals: Box<[Option<Value>]>,
}

impl State {
    /// A state with `n` unassigned slots (`TLCState.Empty.createEmpty()`).
    pub fn empty(n: usize) -> State {
        State { vals: vec![None; n].into_boxed_slice() }
    }

    /// A zero-slot placeholder standing for "no state in scope"
    /// (`TLCState.Empty`): every variable read against it is an error.
    pub fn null() -> State {
        State { vals: Box::new([]) }
    }

    pub fn get(&self, v: VarId) -> Option<&Value> {
        self.vals.get(v.0 as usize).and_then(|s| s.as_ref())
    }

    pub fn is_bound(&self, v: VarId) -> bool {
        self.get(v).is_some()
    }

    pub fn bind(&mut self, v: VarId, val: Value) {
        self.vals[v.0 as usize] = Some(val);
    }

    pub fn unbind(&mut self, v: VarId) {
        self.vals[v.0 as usize] = None;
    }

    /// `TLCState.allAssigned`.
    pub fn all_assigned(&self) -> bool {
        self.vals.iter().all(|s| s.is_some())
    }

    /// Names of unassigned variables, in declaration order.
    pub fn unassigned<'a>(&self, analysis: &'a Analysis, ctx: &ValueCtx<'a>) -> Vec<&'a str> {
        self.vals
            .iter()
            .enumerate()
            .filter(|(_, s)| s.is_none())
            .map(|(i, _)| ctx.interner.str(analysis.vars[i].name))
            .collect()
    }

    /// Fingerprint of a fully-assigned state: values hashed in variable
    /// declaration (VarId) order, as `TLCStateMut.fingerPrint()` hashes in
    /// declaration order.
    pub fn fingerprint(&self, ctx: &ValueCtx) -> Result<u64, Diag> {
        let mut fp = ctx.fp.new_fp();
        for slot in self.vals.iter() {
            let v = slot.as_ref().expect("fingerprint of incomplete state");
            fp = v.fp_extend(fp, ctx)?;
        }
        Ok(fp)
    }

    /// The `/\ x = v` multi-line rendering used in error traces
    /// (`TLCState.toString`).
    pub fn pretty(&self, analysis: &Analysis, ctx: &ValueCtx) -> String {
        let mut out = String::new();
        for (i, slot) in self.vals.iter().enumerate() {
            let name = ctx.interner.str(analysis.vars[i].name);
            let val = match slot {
                Some(v) => v.display(ctx),
                None => "?".to_string(),
            };
            out.push_str(&format!("/\\ {name} = {val}\n"));
        }
        out
    }
}
