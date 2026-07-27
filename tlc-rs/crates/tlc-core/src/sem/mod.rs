//! Semantic analysis: module-graph loading, name resolution, and level
//! checking (milestone M2 — the analog of SANY's Generator + level checker
//! for the safety subset).
//!
//! Entry point: [`analyze`]. It parses the root module, loads the transitive
//! EXTENDS / parameterless-INSTANCE closure through the standard modules and
//! the injected [`ModuleResolver`], resolves every name, and computes levels.
//! `INSTANCE M WITH ...` and `I == INSTANCE M` are rejected with clean
//! `Unsupported` diagnostics (v1 excludes substitution).

pub mod level;
pub mod resolve;

pub use level::{DefLevel, Level};
pub use resolve::{
    Builtin, BinderId, BinderInfo, BinderKind, ConstId, ConstInfo, DefId, DefInfo, DefKind,
    ModuleId, ParamInfo, Ref, Tables, VarId, VarInfo,
};

use crate::diag::{Category, Diag, Diagnostics};
use crate::intern::{Interner, Sym};
use crate::loc::{FileId, Span};
use crate::stdlib;
use crate::syntax::ast::{ExprId, SourceFile, Unit};
use crate::syntax::parse_source;
use crate::ModuleResolver;
use hashbrown::HashMap;

/// One analyzed module: its parse tree plus the semantic side tables that
/// are indexed by its `ExprId`s.
pub struct ModuleInfo {
    pub name: Sym,
    pub file: FileId,
    pub source: SourceFile,
    /// Resolution per ExprId (dense, parallel to the arena): `Some` for every
    /// Ident/Apply and for op nodes bound to user definitions; `None` means
    /// builtin (or an expression behind a reported error).
    pub refs: Vec<Option<Ref>>,
    /// Level per ExprId (0=constant, 1=state, 2=action, 3=temporal).
    pub levels: Vec<Level>,
    /// Names this module makes visible to modules that import it.
    pub exports: HashMap<Sym, Ref>,
}

/// Result of a successful analysis: the whole module graph plus flat
/// definition/variable/constant/binder tables shared across modules.
pub struct Analysis {
    /// Indexed by `ModuleId`, dependencies before dependents; the root is
    /// always last.
    pub modules: Vec<ModuleInfo>,
    pub module_ids: HashMap<Sym, ModuleId>,
    pub root: ModuleId,
    pub defs: Vec<DefInfo>,
    pub vars: Vec<VarInfo>,
    pub consts: Vec<ConstInfo>,
    pub binders: Vec<BinderInfo>,
    /// Indexed by `DefId`.
    pub def_levels: Vec<DefLevel>,
}

impl Analysis {
    pub fn module(&self, m: ModuleId) -> &ModuleInfo {
        &self.modules[m.0 as usize]
    }

    /// Level of an expression of module `m` (0 for ids outside the arena).
    pub fn level(&self, m: ModuleId, e: ExprId) -> Level {
        self.module(m).levels.get(e.0 as usize).copied().unwrap_or(0)
    }

    /// What an Ident/Apply/op node resolved to (None = builtin).
    pub fn expr_ref(&self, m: ModuleId, e: ExprId) -> Option<Ref> {
        self.module(m).refs.get(e.0 as usize).copied().flatten()
    }

    pub fn def_level(&self, d: DefId) -> Level {
        self.def_levels[d.0 as usize].base
    }

    /// First definition named `name` in module `m` (module-level names are
    /// unique; LET-locals may repeat, so prefer this for module-level defs).
    pub fn find_def(&self, interner: &Interner, m: ModuleId, name: &str) -> Option<DefId> {
        let s = interner.get(name)?;
        self.defs
            .iter()
            .position(|d| d.module == m && d.name == s)
            .map(|i| DefId(i as u32))
    }
}

/// Parse and semantically analyze `root_src` (module `root_name`) and its
/// import closure. Standard modules are consulted before `resolver`. Returns
/// every semantic/level diagnostic at once on failure.
pub fn analyze(
    root_name: &str,
    root_src: &str,
    resolver: &dyn ModuleResolver,
    interner: &mut Interner,
) -> Result<Analysis, Vec<Diag>> {
    let root_sf = parse_source(root_src, FileId(0), interner).map_err(|d| vec![d])?;
    let builtins = resolve::BuiltinSyms::new(interner);

    // ---- load the module closure (deps get post-order ModuleIds) ----------
    let mut st = LoadState {
        resolver,
        interner,
        sources: Vec::new(),
        loaded: HashMap::new(),
        loading: Vec::new(),
        next_file: 1,
        diags: Vec::new(),
    };
    let expected = st.interner.intern(root_name);
    if root_sf.module.name != expected {
        st.diags.push(
            Diag::new(
                Category::Semantic,
                "S0003",
                format!(
                    "module is named '{}' but '{}' was requested",
                    st.interner.str(root_sf.module.name),
                    root_name
                ),
            )
            .with_span(root_sf.module.span),
        );
    }
    st.loading.push(root_sf.module.name);
    for (dep, span) in dep_list(&root_sf) {
        load_named(&mut st, dep, span);
    }
    st.loading.pop();
    let root_name_sym = root_sf.module.name;
    st.sources.push((root_name_sym, FileId(0), root_sf));
    if !st.diags.is_empty() {
        return Err(st.diags);
    }
    let sources = st.sources;

    let module_ids: HashMap<Sym, ModuleId> = sources
        .iter()
        .enumerate()
        .map(|(i, (name, _, _))| (*name, ModuleId(i as u32)))
        .collect();
    let root = ModuleId(sources.len() as u32 - 1);

    // ---- name resolution, dependencies first ------------------------------
    let mut sink = Diagnostics::new();
    let mut tables = Tables::default();
    let mut refs_by: Vec<Vec<Option<Ref>>> = Vec::with_capacity(sources.len());
    let mut exports_by: Vec<HashMap<Sym, Ref>> = Vec::with_capacity(sources.len());
    for (i, (_, _, sf)) in sources.iter().enumerate() {
        let res = resolve::resolve_module(
            ModuleId(i as u32),
            sf,
            &mut tables,
            &exports_by,
            &module_ids,
            interner,
            &builtins,
            &mut sink,
        );
        refs_by.push(res.refs);
        exports_by.push(res.exports);
    }

    // ---- level checking, dependencies first -------------------------------
    let mut def_levels: Vec<DefLevel> = tables
        .defs
        .iter()
        .map(|d| DefLevel { base: 0, param_used: vec![false; d.params.len()] })
        .collect();
    let mut levels_by: Vec<Vec<Level>> = Vec::with_capacity(sources.len());
    for (i, (_, _, sf)) in sources.iter().enumerate() {
        levels_by.push(level::check_module(
            ModuleId(i as u32),
            sf,
            &refs_by[i],
            &tables,
            &mut def_levels,
            &mut sink,
        ));
    }

    if sink.has_errors() {
        return Err(sink.items);
    }

    let mut modules = Vec::with_capacity(sources.len());
    for (i, (name, file, sf)) in sources.into_iter().enumerate() {
        modules.push(ModuleInfo {
            name,
            file,
            source: sf,
            refs: std::mem::take(&mut refs_by[i]),
            levels: std::mem::take(&mut levels_by[i]),
            exports: std::mem::take(&mut exports_by[i]),
        });
    }
    Ok(Analysis {
        modules,
        module_ids,
        root,
        defs: tables.defs,
        vars: tables.vars,
        consts: tables.consts,
        binders: tables.binders,
        def_levels,
    })
}

// ---- module loading --------------------------------------------------------

struct LoadState<'a> {
    resolver: &'a dyn ModuleResolver,
    interner: &'a mut Interner,
    /// Post-order (dependencies first); index becomes the ModuleId.
    sources: Vec<(Sym, FileId, SourceFile)>,
    loaded: HashMap<Sym, u32>,
    /// Modules currently on the DFS stack, for cycle detection.
    loading: Vec<Sym>,
    next_file: u32,
    diags: Vec<Diag>,
}

/// Modules a source file imports: EXTENDS plus parameterless INSTANCE.
/// (Unsupported INSTANCE forms are rejected during resolution and their
/// targets deliberately not loaded.)
fn dep_list(sf: &SourceFile) -> Vec<(Sym, Span)> {
    let mut deps: Vec<(Sym, Span)> = sf.module.extends.clone();
    for u in &sf.module.units {
        if let Unit::Instance { decl, .. } = u {
            if decl.def_name.is_none() && decl.with.is_empty() {
                deps.push((decl.module, decl.module_span));
            }
        }
    }
    deps
}

fn load_named(st: &mut LoadState, name: Sym, site: Span) {
    if st.loaded.contains_key(&name) {
        return;
    }
    if st.loading.contains(&name) {
        let mut chain: Vec<&str> = st.loading.iter().map(|s| st.interner.str(*s)).collect();
        chain.push(st.interner.str(name));
        st.diags.push(
            Diag::new(
                Category::Semantic,
                "S0002",
                format!("circular module dependency: {}", chain.join(" -> ")),
            )
            .with_span(site),
        );
        return;
    }
    let name_str = st.interner.str(name).to_string();
    let src: String = if let Some(s) = stdlib::standard_module(&name_str) {
        s.to_string()
    } else if let Some(s) = st.resolver.resolve(&name_str) {
        s.into_owned()
    } else {
        st.diags.push(
            Diag::new(
                Category::Semantic,
                "S0001",
                format!("cannot find module '{name_str}'"),
            )
            .with_span(site),
        );
        return;
    };
    let fid = FileId(st.next_file);
    st.next_file += 1;
    let sf = match parse_source(&src, fid, st.interner) {
        Ok(sf) => sf,
        Err(d) => {
            st.diags.push(d.note(format!("while loading module '{name_str}'"), Some(site)));
            return;
        }
    };
    if sf.module.name != name {
        st.diags.push(
            Diag::new(
                Category::Semantic,
                "S0003",
                format!(
                    "resolved source for module '{name_str}' declares MODULE '{}'",
                    st.interner.str(sf.module.name)
                ),
            )
            .with_span(sf.module.span)
            .note("imported here", Some(site)),
        );
        return;
    }
    st.loading.push(name);
    for (dep, dspan) in dep_list(&sf) {
        load_named(st, dep, dspan);
    }
    st.loading.pop();
    let idx = st.sources.len() as u32;
    st.sources.push((name, fid, sf));
    st.loaded.insert(name, idx);
}
