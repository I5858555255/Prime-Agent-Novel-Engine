use prime_agent_ai::{Cost, Usage};

pub fn empty_usage() -> Usage {
    Usage {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        total_tokens: 0,
        cost: Cost {
            input: 0.0,
            output: 0.0,
            cache_read: 0.0,
            cache_write: 0.0,
            total: 0.0,
        },
    }
}

pub fn add_assistant_usage(total: &mut Usage, usage: &Usage) {
    total.input += usage.input;
    total.output += usage.output;
    total.cache_read += usage.cache_read;
    total.cache_write += usage.cache_write;
    total.total_tokens += usage.total_tokens;
    total.cost.input += usage.cost.input;
    total.cost.output += usage.cost.output;
    total.cost.cache_read += usage.cost.cache_read;
    total.cost.cache_write += usage.cost.cache_write;
    total.cost.total += usage.cost.total;
}

/// Remove a previously added usage, clamping at zero to absorb attribution drift.
pub fn subtract_assistant_usage(total: &mut Usage, usage: &Usage) {
    total.input = total.input.saturating_sub(usage.input);
    total.output = total.output.saturating_sub(usage.output);
    total.cache_read = total.cache_read.saturating_sub(usage.cache_read);
    total.cache_write = total.cache_write.saturating_sub(usage.cache_write);
    total.total_tokens = total.total_tokens.saturating_sub(usage.total_tokens);
    total.cost.input = clamp_cost_at_zero(total.cost.input - usage.cost.input);
    total.cost.output = clamp_cost_at_zero(total.cost.output - usage.cost.output);
    total.cost.cache_read = clamp_cost_at_zero(total.cost.cache_read - usage.cost.cache_read);
    total.cost.cache_write = clamp_cost_at_zero(total.cost.cache_write - usage.cost.cache_write);
    total.cost.total = clamp_cost_at_zero(total.cost.total - usage.cost.total);
}

pub fn clone_usage(usage: &Usage) -> Usage {
    Usage {
        input: usage.input,
        output: usage.output,
        cache_read: usage.cache_read,
        cache_write: usage.cache_write,
        total_tokens: usage.total_tokens,
        cost: Cost {
            input: usage.cost.input,
            output: usage.cost.output,
            cache_read: usage.cost.cache_read,
            cache_write: usage.cost.cache_write,
            total: usage.cost.total,
        },
    }
}

fn clamp_cost_at_zero(value: f64) -> f64 {
    if value < 0.0 { 0.0 } else { value }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 1e-12,
            "expected {actual} to be close to {expected}"
        );
    }

    fn usage(
        input: u64,
        output: u64,
        cache_read: u64,
        cache_write: u64,
        total_tokens: u64,
        cost_total: f64,
    ) -> Usage {
        Usage {
            input,
            output,
            cache_read,
            cache_write,
            total_tokens,
            cost: Cost {
                input: input as f64 / 10.0,
                output: output as f64 / 10.0,
                cache_read: cache_read as f64 / 10.0,
                cache_write: cache_write as f64 / 10.0,
                total: cost_total,
            },
        }
    }

    #[test]
    fn empty_usage_has_zero_tokens_and_cost() {
        assert_eq!(empty_usage(), Usage::default());
    }

    #[test]
    fn add_assistant_usage_accumulates_token_and_cost_fields() {
        let mut total = usage(10, 20, 30, 40, 100, 10.0);
        let delta = usage(1, 2, 3, 4, 10, 1.0);

        add_assistant_usage(&mut total, &delta);

        assert_eq!(total.input, 11);
        assert_eq!(total.output, 22);
        assert_eq!(total.cache_read, 33);
        assert_eq!(total.cache_write, 44);
        assert_eq!(total.total_tokens, 110);
        assert_close(total.cost.input, 1.1);
        assert_close(total.cost.output, 2.2);
        assert_close(total.cost.cache_read, 3.3);
        assert_close(total.cost.cache_write, 4.4);
        assert_close(total.cost.total, 11.0);
    }

    #[test]
    fn subtract_assistant_usage_removes_token_and_cost_fields() {
        let mut total = usage(10, 20, 30, 40, 100, 10.0);
        let delta = usage(1, 2, 3, 4, 10, 1.0);

        subtract_assistant_usage(&mut total, &delta);

        assert_eq!(total.input, 9);
        assert_eq!(total.output, 18);
        assert_eq!(total.cache_read, 27);
        assert_eq!(total.cache_write, 36);
        assert_eq!(total.total_tokens, 90);
        assert_close(total.cost.input, 0.9);
        assert_close(total.cost.output, 1.8);
        assert_close(total.cost.cache_read, 2.7);
        assert_close(total.cost.cache_write, 3.6);
        assert_close(total.cost.total, 9.0);
    }

    #[test]
    fn subtract_assistant_usage_clamps_each_field_at_zero() {
        let mut total = usage(1, 2, 3, 4, 5, 0.5);
        let delta = usage(10, 20, 30, 40, 50, 5.0);

        subtract_assistant_usage(&mut total, &delta);

        assert_eq!(total, Usage::default());
    }

    #[test]
    fn clone_usage_copies_all_fields() {
        let original = usage(7, 8, 9, 10, 34, 3.4);

        let cloned = clone_usage(&original);

        assert_eq!(cloned, original);
    }
}
