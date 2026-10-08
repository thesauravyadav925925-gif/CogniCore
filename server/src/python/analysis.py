#!/usr/bin/env python3
"""
CogniCore data-science worker (Feature 26).
SAFETY: this script does NOT execute user- or LLM-supplied code. It reads one JSON
request from stdin, dispatches to a fixed whitelist of operations, and prints one
JSON response. Standard library only (numpy/scipy are used if present but never required).
"""
import sys, json, math, statistics as st

def num(v):
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None

def clean(xs):
    return [f for f in (num(x) for x in xs) if f is not None]

def quantile(sorted_xs, q):
    if not sorted_xs: return float('nan')
    pos = (len(sorted_xs) - 1) * q
    lo, hi = int(math.floor(pos)), int(math.ceil(pos))
    return sorted_xs[lo] + (sorted_xs[hi] - sorted_xs[lo]) * (pos - lo)

def pearson(x, y):
    n = min(len(x), len(y))
    if n < 3: return None
    x, y = x[:n], y[:n]
    mx, my = sum(x) / n, sum(y) / n
    sxy = sum((a - mx) * (b - my) for a, b in zip(x, y))
    sxx = sum((a - mx) ** 2 for a in x); syy = sum((b - my) ** 2 for b in y)
    d = math.sqrt(sxx * syy)
    return None if d == 0 else sxy / d

def rank(xs):
    order = sorted(range(len(xs)), key=lambda i: xs[i]); r = [0.0] * len(xs); i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]: j += 1
        for k in range(i, j + 1): r[order[k]] = (i + j) / 2 + 1
        i = j + 1
    return r

def op_describe(req):
    out = {}
    for name, col in req['columns'].items():
        xs = clean(col)
        if not xs: out[name] = {'count': 0}; continue
        s = sorted(xs); n = len(xs); m = sum(xs) / n
        sd = st.stdev(xs) if n > 1 else 0.0
        skew = (sum((x - m) ** 3 for x in xs) / n) / (sd ** 3) if sd else 0.0
        kurt = (sum((x - m) ** 4 for x in xs) / n) / (sd ** 4) - 3 if sd else 0.0
        out[name] = {'count': n, 'mean': m, 'std': sd, 'min': s[0], 'q1': quantile(s, .25), 'median': quantile(s, .5),
                     'q3': quantile(s, .75), 'max': s[-1], 'skew': skew, 'excess_kurtosis': kurt}
    return out

def op_correlation(req):
    cols = {k: v for k, v in req['columns'].items()}
    names = list(cols); pairs = []
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            a, b = cols[names[i]], cols[names[j]]
            pts = [(num(x), num(y)) for x, y in zip(a, b)]
            pts = [(x, y) for x, y in pts if x is not None and y is not None]
            if len(pts) < 3: continue
            xs, ys = [p[0] for p in pts], [p[1] for p in pts]
            p = pearson(xs, ys); sp = pearson(rank(xs), rank(ys))
            if p is None: continue
            strength = 'very strong' if abs(p) >= .8 else 'strong' if abs(p) >= .6 else 'moderate' if abs(p) >= .4 else 'weak' if abs(p) >= .2 else 'negligible'
            pairs.append({'a': names[i], 'b': names[j], 'pearson': p, 'spearman': sp, 'n': len(pts),
                          'strength': strength, 'direction': 'positive' if p > 0 else 'negative'})
    pairs.sort(key=lambda r: -abs(r['pearson']))
    return {'pairs': pairs, 'note': 'Correlation does not imply causation.'}

def op_outliers(req):
    xs = [num(v) for v in req['values']]
    valid = [(i, x) for i, x in enumerate(xs) if x is not None]
    if len(valid) < 4: return {'outliers': [], 'method': 'iqr', 'note': 'not enough data'}
    vals = sorted(x for _, x in valid); q1, q3 = quantile(vals, .25), quantile(vals, .75); iqr = q3 - q1
    lo, hi = q1 - 1.5 * iqr, q3 + 1.5 * iqr
    m = sum(vals) / len(vals); sd = st.stdev(vals) if len(vals) > 1 else 0
    out = []
    for i, x in valid:
        z = (x - m) / sd if sd else 0
        if (iqr > 0 and (x < lo or x > hi)) or abs(z) >= 3:
            out.append({'index': i, 'value': x, 'z': z})
    return {'outliers': out, 'method': 'iqr+zscore', 'bounds': {'lower': lo, 'upper': hi}}

def op_regression(req):
    x = clean(req['x']); y = clean(req['y']); n = min(len(x), len(y)); x, y = x[:n], y[:n]
    if n < 3: return {'error': 'need at least 3 points'}
    mx, my = sum(x) / n, sum(y) / n
    sxx = sum((a - mx) ** 2 for a in x); sxy = sum((a - mx) * (b - my) for a, b in zip(x, y))
    if sxx == 0: return {'error': 'x has no variance'}
    slope = sxy / sxx; icpt = my - slope * mx
    ss_res = sum((b - (icpt + slope * a)) ** 2 for a, b in zip(x, y)); ss_tot = sum((b - my) ** 2 for b in y)
    return {'slope': slope, 'intercept': icpt, 'r2': 1 - ss_res / ss_tot if ss_tot else 1.0, 'n': n}

def op_forecast(req):
    y = clean(req['values']); h = int(req.get('horizon', 3))
    if len(y) < 4: return {'error': 'need at least 4 points'}
    n = len(y); xs = list(range(n)); mx, my = sum(xs) / n, sum(y) / n
    b = sum((a - mx) * (c - my) for a, c in zip(xs, y)) / sum((a - mx) ** 2 for a in xs); a0 = my - b * mx
    resid = [c - (a0 + b * a) for a, c in zip(xs, y)]; se = math.sqrt(sum(r * r for r in resid) / max(1, n - 2))
    preds = [{'step': k + 1, 'value': a0 + b * (n + k), 'lower': a0 + b * (n + k) - 1.96 * se, 'upper': a0 + b * (n + k) + 1.96 * se} for k in range(h)]
    return {'type': 'forecast', 'method': 'linear_regression', 'predictions': preds,
            'disclaimer': 'Forecast values are statistical projections, not recorded facts.'}

OPS = {'describe': op_describe, 'correlation': op_correlation, 'outliers': op_outliers, 'regression': op_regression, 'forecast': op_forecast}

if __name__ == '__main__':
    try:
        req = json.loads(sys.stdin.read())
        fn = OPS.get(req.get('op'))
        if not fn: raise ValueError('unsupported op: %s' % req.get('op'))
        print(json.dumps({'ok': True, 'result': fn(req)}, allow_nan=False, default=lambda o: None))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}))
        sys.exit(0)
