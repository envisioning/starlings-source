import re,sys,os,collections
WRITE="--write" in sys.argv; files=[a for a in sys.argv[1:] if not a.startswith("--")]
LIT=re.compile(r"(?<![\w.$])'((?:[^'\\\n]|\\.)*)'")
SKIP=re.compile(r"^\s*(import|export \* |case |//|\*)|className|headers|Content-Type|Authorization|Bearer|localStorage|sessionStorage|StorageKeys|querySelector|getElementById|addEventListener|=== '|!== '|\bhref=|\btype=|\brole=|\bid=|new Date\(|toLocale|Intl\.|\.replace\(|RegExp|console\.|recordMeetError|debug|\bkey[:=]|apiFetch<[^>]*>\('|fetch\(|/api/|\bpath\b|encodeURIComponent")
stats=collections.Counter(); singles=collections.Counter()
def prose(t):
    if not re.search(r"[A-Za-z]{2,}", t) or "/" in t or t.startswith("http"): return False
    if re.match(r"^[A-Z0-9_]+$", t) or re.match(r"^[a-z0-9_.\-:#@?&=%+]+$", t): return False
    if "-" in t and " " not in t: return False
    if re.match(r"^[A-Za-z]+\.[a-z]", t) or "{" in t and "}" in t and " " not in t: return False
    return t[0].isupper() and (" " in t or len(t) >= 4) or (" " in t and t[0] in "…—–•·(\"‘“")
for path in files:
    src=open(path,encoding="utf-8").read(); out=[]
    for line in src.split("\n"):
        new=line
        if not SKIP.search(line):
            def rep(m):
                s=m.start()
                before=new[max(0,s-2):s]
                if before.endswith("t(") or new[m.end():m.end()+1]==":" : return m.group(0)  # already wrapped / object key
                t=m.group(1)
                if not prose(t): return m.group(0)
                stats[os.path.basename(path)]+=1
                if " " not in t: singles[t]+=1
                return f"t('{t}')"
            new=LIT.sub(rep,new)
        out.append(new)
    result="\n".join(out)
    if result!=src and WRITE:
        if "from './i18n'" not in result:
            lines=result.split("\n"); last=max((i for i,l in enumerate(lines) if l.startswith("import ")),default=-1)
            while last>=0 and last+1<len(lines) and not (lines[last].rstrip().endswith(";") or lines[last].rstrip().endswith("'")): last+=1
            lines.insert(last+1,"import { t } from './i18n';"); result="\n".join(lines)
        open(path,"w",encoding="utf-8").write(result)
print(("wrote " if WRITE else "would wrap ")+str(sum(stats.values())))
print(sorted(singles.items(), key=lambda kv:-kv[1])[:80])
