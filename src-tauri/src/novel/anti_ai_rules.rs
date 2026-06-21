use serde::Serialize;
use crate::panic_guard::run_guarded_async;

/// 14 AI slop categories from novel-harness 语病诊断手册
#[derive(Debug, Serialize, Clone)]
pub struct SlopCategory {
    pub id: String,
    pub name: String,
    pub description: String,
    pub example_bad: String,
    pub example_good: String,
}

pub static SLOP_CATEGORIES: &[(&str, &str, &str, &str, &str)] = &[
    ("transition_overuse", "过渡词过度使用", "AI每换话题必加过渡词。一段话最多出现一次过渡词，连续两段以'不过''但是''然而'开头即违规。", "然而/因此/值得注意的是", "直接接下一句/但/所以"),
    ("explanatory_aside", "解释性旁白", "角色做完动作立刻补'因为他……'。全文搜索'因为''毕竟''之所以'——每处都问：不说读者能懂吗？", "他没有接话。因为他不想让话题继续下去。", "他没有接话。"),
    ("overcomplete_action", "动作描写过度完整", "AI标准公式：动作A→连接→动作B→目的。六个字能说清不要用二十个字。", "他伸手从桌上拿起杯子，送到嘴边喝了一口。", "他喝了口水。"),
    ("emotion_labeling", "情感标签化", "用抽象情感词贴标签而非让读者从行为感受。能写身体反应就不写心理感受。", "他感到一阵深深的恐惧。", "他手心全是汗。"),
    ("overcomplete_causality", "因果链过度完整", "AI把因为A所以B然后C完整写出。如果结果说明一切，删掉原因。", "因为门锁已经松了，所以他很容易就能撬开。", "他拿铁片一别，门锁咔哒一声开了。"),
    ("panoramic_scan", "全方位观察综合征", "角色进入新环境做全景扫描。只写角色当前会注意到的2-3个特征。", "房间里有一张床、一张桌子、一把椅子、一个衣柜……", "房间不大，一张床一张桌，收拾得还算干净。"),
    ("relentless_progression", "每段必推进综合征", "AI每段都推进剧情。需要在紧张段落间插入什么都不发生的文字——节奏的呼吸空间。", "进门→对话→冲突→解决→下一场", "进门→对话→...沉默了一会儿→看了看窗外→...接着聊→冲突"),
    ("summary_ending", "标准答案式结尾", "段落结尾用总结陈词把核心意思再说一遍。段尾不需要盖章确认。", "这就是这个世界的残酷之处。", "(删掉最后一句)"),
    ("temporal_adverb", "多余时间副词", "AI在所有动词前加'正在''正准备''刚要'。直接写动作本身即可。", "他正在打开手机查看消息。", "他打开手机看了一眼。"),
    ("identity_retag", "身份重复标签", "反复提醒读者这个人的身份。除非是当前判定依据，不加'作为/身为'。", "作为社区工作者的他", "他"),
    ("repetition_absence", "重复强调缺失", "AI不会用重复强调——觉得重复是浪费。但人写东西恰恰靠重复制造节奏。", "他点了点头。/房间里很安静。", "他点点头。/沉默。沉默。"),
    ("ai_fingerprint", "AI指纹词污染", "高危指纹词：赋能/抓手/底层逻辑（绝对禁用）。中危：迭代/闭环/复盘/对齐/维度/沉淀。", "赋能/加持/底层逻辑/抓手", "帮忙/辅助/绝不用/帮忙/积累了"),
    ("verb_homogenization", "动词同质化（进行病）", "AI用万能动词（进行/做/实施）替代具体动词。全文搜索'进行''实施''做出'——每处问能否换具体动词。", "进行搜索/实施救援/做出回应", "翻了一遍/把人拉出来/回了一句"),
    ("judgment_shortcut", "判定式短句和自问自答", "T0级禁句：正文叙述中的'不是X，是Y'。一章最多1次且仅限对白。改写成可感知细节。", "不是坏了，是快废了。/没错。/也就是说……", "木剑还没坏。剑身边缘已经起了毛刺……"),
];

/// 5 human-linguistics principles from novel-harness SKILL.md
#[derive(Debug, Serialize, Clone)]
pub struct HumanLinguisticsPrinciple {
    pub id: String,
    pub name: String,
    pub description: String,
}

pub static HUMAN_LINGUISTICS_PRINCIPLES: &[(&str, &str, &str)] = &[
    ("redundancy_protection", "人写东西是有废话的", "AI追求信息密度最大化，人不会。人会重复、加不推进剧情的观察、跑题几秒再拉回来。这是人味的来源。"),
    ("imprecise_quantification", "人不做多余的数学", "AI喜欢精确计算——几剑几分钟多少经验。普通人靠感觉和对比。"),
    ("idiosyncrasy", "人写东西有口气", "AI叙述是平的，每个句子同样距离感。人会随情绪起伏：紧张时短句，放松时长句，烦躁时用词变粗。叙述语气应跟着角色状态走。"),
    ("specificity", "人会吐槽也会接时代口气", "真人作者常写嘴硬、吐槽、阴阳怪气、网络调侃。先判断有没有带出口气——有则保留或轻修。"),
    ("rhythm_variance", "人留给读者猜的空间", "AI把所有事解释清楚。普通人选择不说，让读者自己想。不说比说更有力。"),
];

/// Combined Anti-AI rules text for prompt injection
#[derive(Debug, Serialize)]
pub struct AntiAiRules {
    pub slop_categories: Vec<SlopCategory>,
    pub principles: Vec<HumanLinguisticsPrinciple>,
}

impl AntiAiRules {
    pub fn all() -> Self {
        let categories: Vec<SlopCategory> = SLOP_CATEGORIES
            .iter()
            .map(|(id, name, desc, bad, good)| SlopCategory {
                id: id.to_string(),
                name: name.to_string(),
                description: desc.to_string(),
                example_bad: bad.to_string(),
                example_good: good.to_string(),
            })
            .collect();

        let principles: Vec<HumanLinguisticsPrinciple> = HUMAN_LINGUISTICS_PRINCIPLES
            .iter()
            .map(|(id, name, desc)| HumanLinguisticsPrinciple {
                id: id.to_string(),
                name: name.to_string(),
                description: desc.to_string(),
            })
            .collect();

        AntiAiRules { slop_categories: categories, principles }
    }

    /// Format as prompt-injectable text block
    pub fn to_prompt_text(&self) -> String {
        let mut text = String::from("## Anti-AI 规则（预防式注入）\n\n");
        text.push_str("### 14 类 AI 语病诊断（全部门禁规则）\n\n");
        for cat in &self.slop_categories {
            text.push_str(&format!("**{}**（{}）：{}\n- ❌ {}\n- ✅ {}\n\n",
                cat.name, cat.id, cat.description, cat.example_bad, cat.example_good));
        }
        text.push_str("### 5 条人类语感原则\n\n");
        for p in &self.principles {
            text.push_str(&format!("**{}**（{}）：{}\n\n", p.name, p.id, p.description));
        }
        text
    }
}

/// Tauri command: return Anti-AI rules for prompt injection
#[tauri::command]
pub async fn get_anti_ai_rules() -> Result<AntiAiRules, String> {
    run_guarded_async("get_anti_ai_rules", async move {
        Ok(AntiAiRules::all())
    })
    .await
}

/// Tauri command: return formatted Anti-AI prompt text
#[tauri::command]
pub async fn get_anti_ai_prompt_text() -> Result<String, String> {
    run_guarded_async("get_anti_ai_prompt_text", async move {
        Ok(AntiAiRules::all().to_prompt_text())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_slop_categories_count() {
        let rules = AntiAiRules::all();
        assert_eq!(rules.slop_categories.len(), 14, "Should have exactly 14 slop categories");
    }

    #[test]
    fn test_human_linguistics_principles_count() {
        let rules = AntiAiRules::all();
        assert_eq!(rules.principles.len(), 5, "Should have exactly 5 human-linguistics principles");
    }

    #[test]
    fn test_principles_contain_all_ids() {
        let rules = AntiAiRules::all();
        let ids: Vec<&str> = rules.principles.iter().map(|p| p.id.as_str()).collect();
        assert!(ids.contains(&"redundancy_protection"), "Missing redundancy_protection");
        assert!(ids.contains(&"imprecise_quantification"), "Missing imprecise_quantification");
        assert!(ids.contains(&"idiosyncrasy"), "Missing idiosyncrasy");
        assert!(ids.contains(&"specificity"), "Missing specificity");
        assert!(ids.contains(&"rhythm_variance"), "Missing rhythm_variance");
    }

    #[test]
    fn test_prompt_text_is_non_empty() {
        let text = AntiAiRules::all().to_prompt_text();
        assert!(!text.is_empty(), "Prompt text should not be empty");
        assert!(text.contains("Anti-AI"), "Prompt text should contain 'Anti-AI'");
        assert!(text.contains("14"), "Prompt text should reference 14 categories");
    }
}
